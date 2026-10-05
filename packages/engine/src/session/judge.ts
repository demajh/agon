import {
  JudgementSchema,
  type Judgement,
  type LlmClient,
  type Observation,
  type PersonaInstance,
  type Scenario,
  type SessionOutcome,
  type Step,
} from '@agon/spec';
import { describeAction } from '../agent/prompts.js';

export const JudgeOutputSchema = JudgementSchema.omit({ usage: true });

export interface JudgeDeps {
  llm: LlmClient;
  model: string;
  temperature?: number | undefined;
}

export interface JudgeInput {
  persona: PersonaInstance;
  scenario: Scenario;
  steps: readonly Step[];
  finalObservation?: Observation | undefined;
  outcome?: SessionOutcome | undefined;
  outcomeReason?: string | undefined;
}

const JUDGE_SYSTEM = [
  'You are an impartial UX researcher reviewing a recorded session of one simulated user.',
  "Decide whether the user accomplished their goal, and rate the experience from the user's point of view.",
  'Judge only from the transcript. Do not assume success because the user said they were done; look at what the pages showed.',
  'satisfaction: 1 (miserable) to 5 (delighted). frustration: 1 (none) to 5 (gave up angry). confidence: how sure you are of the success call, 0 to 1.',
  'Respond with the JSON object only.',
].join('\n');

export function buildJudgeMessage(input: JudgeInput): string {
  const lines: string[] = [
    `USER: ${input.persona.name} — ${input.persona.traits.role}.`,
    `GOAL: ${input.scenario.goal.trim()}`,
    '',
    'TRANSCRIPT:',
  ];
  for (const step of input.steps) {
    lines.push(
      `--- step ${step.index + 1} at ${step.observation.url}`,
      `noticed: ${step.decision.perception}`,
      `thought: ${step.decision.thinking}`,
      `felt: ${step.decision.feeling}; progress: ${step.decision.progress}`,
      `did: ${describeAction(step.decision.action)} → ${step.result.ok ? 'ok' : `failed: ${step.result.error ?? 'unknown'}`}`,
    );
  }
  if (input.finalObservation) {
    lines.push(
      '',
      'FINAL PAGE:',
      `URL: ${input.finalObservation.url}`,
      input.finalObservation.text.slice(0, 1500),
    );
  }
  if (input.outcome)
    lines.push(
      '',
      `SESSION ENDED: ${input.outcome}${input.outcomeReason ? ` (${input.outcomeReason})` : ''}`,
    );
  return lines.join('\n');
}

/** Independent post-hoc assessment. Kept separate from the acting agent to avoid self-report bias. */
export async function judgeSession(deps: JudgeDeps, input: JudgeInput): Promise<Judgement> {
  const response = await deps.llm.generateObject({
    model: deps.model,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: buildJudgeMessage(input) }],
    schema: JudgeOutputSchema,
    schemaName: 'judgement',
    temperature: deps.temperature ?? 0,
    purpose: 'judge',
  });
  return { ...response.object, usage: response.usage };
}
