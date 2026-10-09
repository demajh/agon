import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAdapter, FakeLlm, happyUser, ledgerlySite, testConfig } from '@agon/engine/fakes';
import {
  AgonConfigSchema,
  ResultSchema,
  SIM_PROPERTY_KEYS,
  type AgonConfig,
  type AgonEvent,
  type Environment,
  type LlmClient,
  type LlmObjectRequest,
  type Result,
  type Run,
  type Session,
  type Squad,
  type Step,
} from '@agon/spec';
import { resolveStatsBinary } from '@agon/stats-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultStatsClient } from './index.js';
import type { RunDependenciesFactory } from './worker/deps.js';
import {
  describeDb,
  startLocalHttpServer,
  stubStats,
  useTestServer,
  waitFor,
  type LocalHttpServer,
} from './testing/harness.js';

function realStatsAvailable(): boolean {
  if (process.env['AGON_SKIP_STATS_TESTS'] === '1') return false;
  try {
    resolveStatsBinary();
    return true;
  } catch {
    return false;
  }
}

const USE_REAL_STATS = realStatsAvailable();

/** Ledgerly config with every-step screenshots, treatment credited to squad blue. */
function runConfig(size = 4): AgonConfig {
  const base = testConfig();
  return AgonConfigSchema.parse({
    ...base,
    population: { ...base.population, size },
    analysis: { ...base.analysis, minSessionsPerVariant: 2 },
    target: {
      ...base.target,
      capture: { ...base.target.capture, screenshots: 'every_step' },
      variants: {
        control: { url: 'http://control.test' },
        treatment: { url: 'http://treatment.test', squad: 'blue' },
      },
    },
  });
}

/** A FakeLlm that takes `delayMs` per decision so runs last long enough to cancel. */
function slowFakeDeps(delayMs: number): RunDependenciesFactory {
  return () => {
    const inner = new FakeLlm(happyUser);
    const llm: LlmClient = {
      async generateObject<T>(request: LlmObjectRequest<T>) {
        await new Promise((r) => setTimeout(r, delayMs));
        return inner.generateObject(request);
      },
      generateText: (request) => inner.generateText(request),
    };
    return { llm, adapter: new FakeAdapter(ledgerlySite) };
  };
}

describeDb('run lifecycle through the pg-boss worker', () => {
  let webhooks: LocalHttpServer;
  beforeAll(async () => {
    webhooks = await startLocalHttpServer();
  });
  afterAll(async () => {
    await webhooks.close();
  });

  const h = useTestServer({
    stats: USE_REAL_STATS ? defaultStatsClient() : stubStats(),
    get webhookUrl() {
      return webhooks.url;
    },
  });

  async function setup(size = 4): Promise<Environment> {
    await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
    const created = await h.t.request('POST', '/v1/environments', {
      body: { config: runConfig(size) },
    });
    expect(created.status).toBe(201);
    return created.json<Environment>();
  }

  async function waitForRun(
    id: string,
    statuses: Run['status'][] = ['completed', 'failed', 'cancelled'],
  ): Promise<Run> {
    return waitFor(
      async () => (await h.t.request('GET', `/v1/runs/${id}`)).json<Run>(),
      (run) => statuses.includes(run.status),
      { timeoutMs: 60_000 },
    );
  }

  it(`runs an experiment end to end (${USE_REAL_STATS ? 'real agon-stats' : 'stubbed stats'})`, async () => {
    const env = await setup();
    const started = await h.t.request('POST', `/v1/environments/${env.id}/runs`, {
      body: { seed: 3 },
    });
    expect(started.status).toBe(201);
    const queued = await started.json<Run>();
    expect(queued).toMatchObject({
      status: 'queued',
      environmentId: env.id,
      variants: ['control', 'treatment'],
      seed: 3,
    });
    expect((await h.t.request('GET', `/v1/runs/${queued.id}/results`)).status).toBe(404);

    const run = await waitForRun(queued.id);
    expect(run.status).toBe('completed');
    expect(run.counts).toMatchObject({ planned: 4, completed: 4, failed: 0, running: 0 });
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.startedAt).toBeDefined();
    expect(run.finishedAt).toBeDefined();
    expect(run.termination).toMatchObject({
      kind: 'completed',
      capMs: 720_000,
      sessionsExecuted: 4,
      sessionsPlanned: 4,
      failureCount: 0,
    });
    // Analysis runs inside the engine's runFinished; the export stage closes right after.
    expect(['analysis', 'export']).toContain(run.termination?.lastCompletedStage);
    expect(run.sampleHash).toMatch(/^[0-9a-f]{64}$/);
    // The evaluation ledger counted both variants when the run started and closed them after.
    const ledgerRows = await h.t.pool.query<{ variant: string; role: string; event: string }>(
      'select variant, role, event from evaluation_ledger where run_id = $1 order by id',
      [run.id],
    );
    expect(ledgerRows.rows.slice(0, 4)).toEqual([
      { variant: 'control', role: 'control', event: 'started' },
      { variant: 'treatment', role: 'treatment', event: 'started' },
      { variant: 'control', role: 'control', event: 'completed' },
      { variant: 'treatment', role: 'treatment', event: 'completed' },
    ]);
    for (const row of ledgerRows.rows.slice(4)) expect(['promoted', 'killed']).toContain(row.event);

    const listed = await h.t.request('GET', `/v1/environments/${env.id}/runs?status=completed`);
    expect((await listed.json<{ items: Run[] }>()).items.map((r) => r.id)).toEqual([run.id]);

    const sessions = await (
      await h.t.request('GET', `/v1/runs/${run.id}/sessions`)
    ).json<{ items: Session[] }>();
    expect(sessions.items).toHaveLength(4);
    expect(sessions.items.every((s) => s.status === 'finished' && s.outcome === 'success')).toBe(
      true,
    );
    const treatmentOnly = await (
      await h.t.request('GET', `/v1/runs/${run.id}/sessions?variant=treatment`)
    ).json<{ items: Session[] }>();
    expect(treatmentOnly.items.map((s) => s.variant)).toEqual(['treatment', 'treatment']);

    const first = sessions.items[0]!;
    expect((await h.t.request('GET', `/v1/sessions/${first.id}`)).status).toBe(200);
    const trace = await (
      await h.t.request('GET', `/v1/sessions/${first.id}/trace`)
    ).json<{
      session: Session;
      steps: Step[];
      events: AgonEvent[];
    }>();
    expect(trace.session.id).toBe(first.id);
    expect(trace.steps.length).toBeGreaterThan(3);
    expect(trace.steps.map((s) => s.index)).toEqual(trace.steps.map((_, i) => i));
    expect(trace.events.length).toBeGreaterThan(0);
    for (const event of trace.events) {
      for (const key of SIM_PROPERTY_KEYS) {
        if (key === 'agon_scenario') continue;
        expect(event.properties[key], `${event.event} ${key}`).toBeDefined();
      }
      expect(event.properties['agon_simulated']).toBe(true);
    }
    expect(trace.events.some((e) => e.event === 'project_created')).toBe(true);

    const screenshot = await h.t.request(
      'GET',
      `/v1/runs/${run.id}/screenshots/${trace.steps[0]!.id}`,
    );
    expect(screenshot.status).toBe(200);
    expect(screenshot.response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await screenshot.response.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect((await h.t.request('GET', `/v1/runs/${run.id}/screenshots/stp_nope`)).status).toBe(404);
    expect((await h.t.request('GET', `/v1/runs/${run.id}/screenshots/..%2F..%2Fetc`)).status).toBe(
      404,
    );

    const resultResponse = await h.t.request('GET', `/v1/runs/${run.id}/results`);
    expect(resultResponse.status).toBe(200);
    if (USE_REAL_STATS) {
      const stored = await resultResponse.json<Result>();
      expect(stored.decision.rationale).toContain('Trials: M=1 distinct variant(s)');
      expect(stored.decision.rationale).toContain(`sample ${run.sampleHash?.slice(0, 12)}`);
    }
    const result = ResultSchema.parse(await resultResponse.json<Result>());
    expect(result.runId).toBe(run.id);
    expect(result.control).toBe('control');
    expect(result.primaryMetricId).toBe('activation');
    expect(result.calibration.note.length).toBeGreaterThan(0);
    expect(run.resultId).toBe(result.id);

    const runDir = join(h.t.dataDir, 'runs', run.id);
    expect(readFileSync(join(runDir, 'sessions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
    expect(existsSync(join(runDir, 'result.json'))).toBe(true);

    // Scoring and webhooks happen after the run row turns completed; poll instead of racing them.
    const blue = await (async () => {
      let found: Squad | undefined;
      for (let i = 0; i < 150; i++) {
        found = (
          await (await h.t.request('GET', '/v1/squads')).json<{ items: Squad[] }>()
        ).items.find((s) => s.slug === 'blue');
        const completedSeen = webhooks.requests.some(
          (r) => (r.body as { event: string }).event === 'run.completed',
        );
        if (found && found.score.runs >= 1 && completedSeen) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return found;
    })();
    expect(blue?.score.runs).toBe(1);
    expect(blue?.score.costUsd).toBeGreaterThan(0);

    const events = webhooks.requests.map((r) => (r.body as { event: string }).event);
    expect(events).toContain('result.ready');
    expect(events).toContain('run.completed');
    const completed = webhooks.requests.find(
      (r) => (r.body as { event: string }).event === 'run.completed',
    )!;
    expect(completed.headers['x-agon-event']).toBe('run.completed');
    expect((completed.body as { data: { run: Run } }).data.run.id).toBe(run.id);
  });

  it('plans a dry run without executing sessions', async () => {
    const env = await setup();
    const started = await h.t.request('POST', `/v1/environments/${env.id}/runs`, {
      body: { dryRun: true, variants: ['control'] },
    });
    const run = await waitForRun((await started.json<Run>()).id);
    expect(run.status).toBe('completed');
    expect(run.variants).toEqual(['control']);
    expect(run.counts.completed).toBe(0);
    expect(
      (await (await h.t.request('GET', `/v1/runs/${run.id}/sessions`)).json<{ items: Session[] }>())
        .items,
    ).toEqual([]);
    expect((await h.t.request('GET', `/v1/runs/${run.id}/results`)).status).toBe(404);
  });

  it('rejects unknown variants and missing environments', async () => {
    const env = await setup();
    const bad = await h.t.request('POST', `/v1/environments/${env.id}/runs`, {
      body: { variants: ['nope'] },
    });
    expect(bad.status).toBe(400);
    expect(
      (await h.t.request('POST', '/v1/environments/env_missing/runs', { body: {} })).status,
    ).toBe(404);
    expect((await h.t.request('GET', '/v1/runs/run_missing')).status).toBe(404);
    expect((await h.t.request('POST', '/v1/runs/run_missing/cancel')).status).toBe(404);
  });

  it('applies size and model overrides to the config snapshot', async () => {
    const env = await setup();
    const started = await h.t.request('POST', `/v1/environments/${env.id}/runs`, {
      body: { size: 2, model: 'fake/model-2', dryRun: true },
    });
    const run = await started.json<Run>();
    expect(run.config.population.size).toBe(2);
    expect(run.config.defaults.model).toBe('fake/model-2');
    expect(run.counts.planned).toBe(2);
    await waitForRun(run.id);
  });
});

describeDb('cancelling runs', () => {
  const h = useTestServer({ runDependencies: slowFakeDeps(40) });

  it('cancels a running run between sessions', async () => {
    await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'Blue' } });
    const env = await (
      await h.t.request('POST', '/v1/environments', { body: { config: runConfig(60) } })
    ).json<Environment>();
    const started = await (
      await h.t.request('POST', `/v1/environments/${env.id}/runs`, { body: {} })
    ).json<Run>();
    await waitFor(
      async () => (await h.t.request('GET', `/v1/runs/${started.id}`)).json<Run>(),
      (run) => run.status === 'running' && run.counts.completed >= 1,
    );
    const cancelled = await h.t.request('POST', `/v1/runs/${started.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json<Run>()).status).toBe('cancelled');

    const final = await waitFor(
      async () => (await h.t.request('GET', `/v1/runs/${started.id}`)).json<Run>(),
      (run) =>
        run.status === 'cancelled' && run.counts.running === 0 && run.finishedAt !== undefined,
      { timeoutMs: 30_000 },
    );
    expect(final.counts.completed + final.counts.failed).toBeLessThan(final.counts.planned);
    expect(final.counts.completed).toBeGreaterThan(0);
    const again = await h.t.request('POST', `/v1/runs/${started.id}/cancel`);
    expect(again.status).toBe(409);
    expect((await h.t.request('GET', `/v1/runs/${started.id}/results`)).status).toBe(404);
  });
});

describe('cancelling a queued run (API-only process)', () => {
  const h = useTestServer({ role: 'api' });

  it('cancels before any worker picks the job up', async () => {
    const env = await (
      await h.t.request('POST', '/v1/environments', { body: { config: runConfig(4) } })
    ).json<Environment>();
    const started = await (
      await h.t.request('POST', `/v1/environments/${env.id}/runs`, { body: {} })
    ).json<Run>();
    expect(started.status).toBe('queued');
    const cancelled = await (
      await h.t.request('POST', `/v1/runs/${started.id}/cancel`)
    ).json<Run>();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBeDefined();
    const health = await (
      await h.t.request('GET', '/healthz', { key: null })
    ).json<{ role: string }>();
    expect(health.role).toBe('api');
  });
});
