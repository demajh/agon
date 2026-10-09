import {
  INFERRED_EVENTS,
  deterministicId,
  nowIso,
  simProperties,
  type ActResult,
  type Action,
  type Adapter,
  type AdapterSession,
  type AgonConfig,
  type AgonEvent,
  type EventDraft,
  type LlmClient,
  type LlmUsage,
  type Observation,
  type Recorder,
  type Session,
  type SessionOutcome,
  type Step,
  type VariantSpec,
} from '@agon/spec';
import type { Logger } from 'pino';
import {
  DEFAULT_PATIENCE,
  initialPatience,
  shouldAbandon,
  updatePatience,
  type PatienceParams,
} from '../agent/patience.js';
import { perceptionLimitsFor, pruneObservation } from '../agent/perception.js';
import { buildStepMessage, buildSystemPrompt, summarizeStep } from '../agent/prompts.js';
import { decideNextAction } from '../agent/user-agent.js';
import type { SessionPlan } from '../population/sampler.js';
import { createRng, hashSeed } from '../rng.js';
import { runHook } from './hooks.js';
import { judgeSession } from './judge.js';
import { computeSessionMetrics } from './metrics.js';
import { ProgressTracker, progressHash } from './progress.js';
import { criterionMet } from './success.js';

export interface SessionDeps {
  llm: LlmClient;
  adapter: Adapter;
  recorder: Recorder;
  logger: Logger;
  /** Base directory for session hooks. */
  cwd: string;
  patience?: PatienceParams | undefined;
  /** Reuse decisions for identical (persona, scenario, page, history) states via the LLM cache. Default true. */
  cacheDecisions?: boolean | undefined;
  /** Fires to stop the session between steps; the session finishes as failed with reason "cancelled". */
  signal?: AbortSignal | undefined;
}

export interface SessionInput {
  runId: string;
  config: AgonConfig;
  plan: SessionPlan;
  variantSpec: VariantSpec;
}

export interface SessionResult {
  session: Session;
  steps: Step[];
  events: AgonEvent[];
}

function addUsage(session: Session, usage: LlmUsage): void {
  session.costUsd += usage.costUsd;
  session.inputTokens += usage.inputTokens;
  session.outputTokens += usage.outputTokens;
}

function hasRef(action: Action): action is Extract<Action, { ref: string }> {
  return 'ref' in action;
}

/** Drives one simulated user through one variant and records everything that happened. */
export async function runSession(input: SessionInput, deps: SessionDeps): Promise<SessionResult> {
  const { config, plan, runId, variantSpec } = input;
  const { scenario, persona } = plan;
  const log = deps.logger.child({
    sessionId: plan.sessionId,
    variant: plan.variant,
    persona: persona.personaId,
  });
  const patienceParams = deps.patience ?? DEFAULT_PATIENCE;

  const session: Session = {
    id: plan.sessionId,
    runId,
    index: plan.index,
    variant: plan.variant,
    scenarioId: scenario.id,
    persona,
    status: 'running',
    steps: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    metrics: {},
    startedAt: nowIso(),
  };
  await deps.recorder.sessionStarted(session);

  const steps: Step[] = [];
  const events: AgonEvent[] = [];
  let eventCounter = 0;
  const sim = simProperties({
    runId,
    sessionId: session.id,
    variant: plan.variant,
    personaId: persona.personaId,
    model: persona.model,
    scenarioId: scenario.id,
  });
  const stamp = (draft: EventDraft): AgonEvent => ({
    id: deterministicId('evt', session.id, eventCounter++, 4),
    runId,
    sessionId: session.id,
    timestamp: draft.timestamp,
    event: draft.event,
    distinctId: persona.distinctId,
    source: draft.source,
    ...(draft.provider === undefined ? {} : { provider: draft.provider }),
    properties: { ...draft.properties, ...sim },
  });
  const emit = async (drafts: EventDraft[]): Promise<void> => {
    if (drafts.length === 0) return;
    const stamped = drafts.map(stamp);
    events.push(...stamped);
    await deps.recorder.events(stamped);
  };
  const inferred = (event: string, properties: Record<string, unknown> = {}): EventDraft => ({
    timestamp: nowIso(),
    event,
    source: 'inferred',
    properties,
  });

  const rng = createRng(hashSeed(persona.seed, 'patience'));
  const kind = config.target.kind;
  const limits = perceptionLimitsFor(persona);
  const progress = new ProgressTracker();
  let patience = initialPatience(persona.traits, patienceParams);
  const history: string[] = [];
  let lastAction: Action | undefined;
  let lastResult: ActResult | undefined;
  let lastFailedActionKey: string | undefined;
  let lastObservation: Observation | undefined;
  let outcome: SessionOutcome | undefined;
  let outcomeReason: string | undefined;
  let declaredDone = false;
  let adapterSession: AdapterSession | undefined;
  let credentials: Record<string, string> | undefined;
  const hookEnv: Record<string, string> = {
    AGON_RUN_ID: runId,
    AGON_SESSION_ID: session.id,
    AGON_VARIANT: plan.variant,
    AGON_VARIANT_URL: variantSpec.url ?? '',
    ...variantSpec.env,
  };

  try {
    if (config.target.session.setup) {
      const hook = await runHook(config.target.session.setup, {
        cwd: deps.cwd,
        env: hookEnv,
        timeoutMs: config.target.session.timeoutMs,
      });
      credentials = hook.output;
      hookEnv.AGON_CREDENTIALS = JSON.stringify(credentials);
    }
    adapterSession = await deps.adapter.open(variantSpec, {
      sessionId: session.id,
      variant: plan.variant,
      startPath: scenario.startPath,
      viewport: config.target.viewport,
      device: persona.device,
      locale: persona.locale,
      capture: config.target.capture,
      ...(credentials === undefined ? {} : { credentials }),
      headers: variantSpec.headers,
      timeoutMs: config.target.session.timeoutMs,
    });
    await emit([
      inferred(INFERRED_EVENTS.sessionStart, {
        $current_url: variantSpec.url ?? '',
        start_path: scenario.startPath,
      }),
    ]);
    const system = buildSystemPrompt({ persona, scenario, credentials, kind });

    for (let stepIndex = 0; stepIndex < scenario.maxSteps; stepIndex++) {
      if (deps.signal?.aborted) {
        session.status = 'failed';
        session.error = 'cancelled';
        outcome = 'error';
        outcomeReason = 'cancelled';
        break;
      }
      const stepStartedAt = Date.now();
      const observation = pruneObservation(
        await adapterSession.observe({
          maxTextChars: limits.maxTextChars,
          maxInteractive: limits.maxInteractive,
        }),
        limits,
      );
      lastObservation = observation;
      await emit(adapterSession.drainEvents());
      // The state observed now is the result of the previous step; the first observation only
      // seeds the hash. Every action or tool call is a step, reads and writes alike.
      progress.observe(progressHash(scenario.progress, observation, events), steps.length);
      if (criterionMet(scenario.success, observation, events)) {
        outcome = 'success';
        outcomeReason = 'success criterion met';
        break;
      }
      if (progress.stalled(scenario.stallSteps)) {
        outcome = 'stalled';
        outcomeReason = `no progress for ${scenario.stallSteps} steps`;
        break;
      }

      const message = buildStepMessage({
        stepIndex,
        maxSteps: scenario.maxSteps,
        patience,
        lastAction,
        lastResult,
        history,
        observation,
        kind,
      });
      const cacheKey =
        deps.cacheDecisions === false
          ? undefined
          : String(
              hashSeed(
                persona.personaId,
                scenario.id,
                persona.model,
                observation.hash,
                stepIndex,
                history.at(-1) ?? '',
              ),
            );
      const { decision, usage } = await decideNextAction(
        { llm: deps.llm, model: persona.model, temperature: config.defaults.temperature },
        { system, message, cacheKey },
      );
      addUsage(session, usage);
      const action = decision.action;

      let result: ActResult;
      if (hasRef(action) && !observation.interactive.some((el) => el.ref === action.ref)) {
        result = { ok: false, error: `there is no ${action.ref} on this page`, navigated: false };
      } else if (action.type === 'give_up' || action.type === 'done') {
        result = { ok: true, navigated: false };
      } else {
        result = await adapterSession.act(action);
        if (kind === 'web' && action.type === 'click' && result.ok) {
          const el = observation.interactive.find((e) => e.ref === action.ref);
          await emit([
            inferred(INFERRED_EVENTS.click, {
              ref: action.ref,
              role: el?.role,
              name: el?.name,
              $current_url: observation.url,
            }),
          ]);
        }
      }
      await emit(adapterSession.drainEvents());

      const actionKey = JSON.stringify(action);
      const repeatedFailure = !result.ok && lastFailedActionKey === actionKey;
      lastFailedActionKey = result.ok ? undefined : actionKey;
      patience = updatePatience(
        patience,
        {
          traits: persona.traits,
          progress: decision.progress,
          feeling: decision.feeling,
          errors: observation.errors.length,
          actionOk: result.ok,
          repeatedFailure,
        },
        patienceParams,
      );
      const step: Step = {
        id: deterministicId('stp', session.id, stepIndex, 3),
        sessionId: session.id,
        index: stepIndex,
        observation,
        decision,
        result,
        patience,
        usage,
        startedAt: new Date(stepStartedAt).toISOString(),
        durationMs: Date.now() - stepStartedAt,
      };
      steps.push(step);
      session.steps = steps.length;
      const screenshot = await maybeScreenshot(
        config.target.capture.screenshots,
        decision.feeling,
        stepIndex,
        adapterSession,
      );
      await deps.recorder.step(step, screenshot);
      history.push(
        summarizeStep(stepIndex, decision, result) +
          (repeatedFailure ? ' (the same thing failed twice; this is not working)' : ''),
      );
      lastAction = action;
      lastResult = result;

      if (session.costUsd > scenario.budgetUsd) {
        outcome = 'budget_exceeded';
        outcomeReason = `spent $${session.costUsd.toFixed(4)} of a $${scenario.budgetUsd} budget`;
        break;
      }
      if (action.type === 'give_up') {
        outcome = 'gave_up';
        outcomeReason = action.reason;
        await emit([
          inferred(INFERRED_EVENTS.abandon, {
            reason: action.reason,
            patience,
            step: stepIndex + 1,
          }),
        ]);
        break;
      }
      if (action.type === 'done') {
        declaredDone = true;
        if (scenario.success.type === 'judge' || scenario.success.type === 'check') {
          outcomeReason = `declared done: ${action.reason}`;
          break;
        }
        const after = pruneObservation(
          await adapterSession.observe({
            maxTextChars: limits.maxTextChars,
            maxInteractive: limits.maxInteractive,
          }),
          limits,
        );
        lastObservation = after;
        await emit(adapterSession.drainEvents());
        if (criterionMet(scenario.success, after, events)) {
          outcome = 'success';
          outcomeReason = 'success criterion met';
        } else {
          outcome = 'gave_up';
          outcomeReason = `declared done without reaching the success criterion: ${action.reason}`;
        }
        break;
      }
      if (shouldAbandon(patience, rng, patienceParams)) {
        outcome = 'gave_up';
        outcomeReason = 'patience exhausted';
        await emit([
          inferred(INFERRED_EVENTS.abandon, {
            reason: 'patience exhausted',
            patience,
            step: stepIndex + 1,
          }),
        ]);
        break;
      }
    }
    if (outcome === undefined && !declaredDone && steps.length >= scenario.maxSteps) {
      outcome = 'max_steps';
      outcomeReason = `reached the ${scenario.maxSteps}-step limit`;
    }
  } catch (error) {
    session.status = 'failed';
    session.error = error instanceof Error ? error.message : String(error);
    outcome = 'error';
    outcomeReason = session.error;
    log.error({ err: error }, 'session failed');
  } finally {
    if (adapterSession) {
      try {
        await adapterSession.close();
      } catch (error) {
        log.warn({ err: error }, 'failed to close adapter session');
      }
    }
    if (config.target.session.teardown) {
      try {
        await runHook(config.target.session.teardown, {
          cwd: deps.cwd,
          env: hookEnv,
          timeoutMs: config.target.session.timeoutMs,
        });
      } catch (error) {
        log.warn({ err: error }, 'teardown hook failed');
      }
    }
  }

  if (scenario.success.type === 'check' && session.status !== 'failed') {
    const check = scenario.success;
    try {
      await runHook(check.command, {
        cwd: deps.cwd,
        env: { ...hookEnv, AGON_DECLARED_DONE: String(declaredDone), AGON_OUTCOME: outcome ?? '' },
        timeoutMs: config.target.session.timeoutMs,
      });
      outcome = 'success';
      outcomeReason = 'state check passed';
    } catch (error) {
      const detail =
        error instanceof Error
          ? (error.message.trim().split('\n').at(-1) ?? error.message)
          : String(error);
      if (outcome === undefined) {
        outcome = 'gave_up';
        outcomeReason = `state check failed after the agent declared done: ${detail}`;
      } else {
        outcomeReason = `${outcomeReason ?? outcome}; state check failed: ${detail}`;
      }
      log.info({ check: check.command }, 'state check failed');
    }
  }

  const needsJudge =
    scenario.success.type === 'judge' || config.metrics.some((m) => m.type === 'score');
  if (needsJudge && steps.length > 0 && session.status !== 'failed') {
    try {
      const judgement = await judgeSession(
        {
          llm: deps.llm,
          model: config.defaults.judgeModel ?? config.defaults.model,
          temperature: 0,
        },
        { persona, scenario, steps, finalObservation: lastObservation, outcome, outcomeReason },
      );
      session.judgement = judgement;
      if (judgement.usage) addUsage(session, judgement.usage);
      if (
        scenario.success.type === 'judge' &&
        (outcome === undefined || outcome === 'max_steps' || outcome === 'stalled')
      ) {
        outcome = judgement.success ? 'success' : (outcome ?? 'gave_up');
        outcomeReason = judgement.success
          ? `judge: ${judgement.summary}`
          : (outcomeReason ?? `judge: ${judgement.summary}`);
      }
    } catch (error) {
      log.warn({ err: error }, 'judge failed; continuing without judgement');
    }
  }
  if (outcome === undefined) {
    outcome = declaredDone ? 'gave_up' : 'error';
    outcomeReason ??= declaredDone
      ? 'declared done; no judge available'
      : 'session ended without an outcome';
  }
  if (outcome === 'success')
    await emit([inferred(INFERRED_EVENTS.success, { steps: steps.length })]);
  await emit([
    inferred(INFERRED_EVENTS.sessionEnd, {
      outcome,
      reason: outcomeReason,
      steps: steps.length,
      cost_usd: session.costUsd,
    }),
  ]);

  session.outcome = outcome;
  if (outcomeReason !== undefined) session.outcomeReason = outcomeReason;
  session.status = session.status === 'failed' ? 'failed' : 'finished';
  session.finishedAt = nowIso();
  Object.assign(session, progress.summary());
  session.metrics = computeSessionMetrics(config, session, events);
  await deps.recorder.sessionFinished(session);
  log.info({ outcome, steps: steps.length, costUsd: session.costUsd }, 'session finished');
  return { session, steps, events };
}

async function maybeScreenshot(
  mode: 'never' | 'on_decision' | 'every_step',
  feeling: string,
  stepIndex: number,
  adapterSession: AdapterSession,
): Promise<Uint8Array | undefined> {
  if (mode === 'never') return undefined;
  if (mode === 'on_decision' && feeling === 'neutral' && stepIndex % 5 !== 0) return undefined;
  try {
    return await adapterSession.screenshot();
  } catch {
    return undefined;
  }
}
