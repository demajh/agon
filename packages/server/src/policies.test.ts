import { decisions, environments, results, runs, squads } from '@agon/db';
import { testConfig } from '@agon/engine/fakes';
import {
  AgonConfigSchema,
  PolicyBlockedError,
  PolicySchema,
  type AgonConfig,
  type Result,
  type Run,
} from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  checkProtectedPaths,
  enforceProtectedPaths,
  evaluateCondition,
  evaluatePolicies,
  parseCondition,
  referencedVariables,
  resolveVariables,
  validatePolicies,
  variableKey,
} from './policies.js';
import { describeDb, useTestServer } from './testing/harness.js';

const values = (entries: Record<string, number | string | undefined>) =>
  new Map(Object.entries(entries));

describe('policy expression grammar', () => {
  it('parses comparisons with every operator and value kind', () => {
    expect(parseCondition('result.p_best >= 0.95')).toEqual({
      type: 'cmp',
      left: { name: 'result.p_best' },
      op: '>=',
      right: { kind: 'number', value: 0.95 },
    });
    expect(parseCondition("result.verdict == 'ship'")).toEqual({
      type: 'cmp',
      left: { name: 'result.verdict' },
      op: '==',
      right: { kind: 'string', value: 'ship' },
    });
    expect(parseCondition('result.verdict != kill').right).toEqual({
      kind: 'string',
      value: 'kill',
    });
    expect(parseCondition('squad.p_best_rolling(5) < 0.10').left).toEqual({
      name: 'squad.p_best_rolling',
      arg: 5,
    });
    expect(parseCondition('squad.runs > -1').right).toEqual({ kind: 'number', value: -1 });
  });

  it('binds and tighter than or, and honours parentheses', () => {
    const expr = parseCondition(
      'squad.runs >= 5 and squad.win_rate < 0.2 or result.verdict == kill',
    );
    expect(expr.type).toBe('or');
    const grouped = parseCondition(
      'squad.runs >= 5 AND (squad.win_rate < 0.2 OR result.verdict == kill)',
    );
    expect(grouped.type).toBe('and');
    const v = values({ 'squad.runs': 6, 'squad.win_rate': 0.5, 'result.verdict': 'kill' });
    expect(evaluateCondition(expr, v)).toBe(true);
    expect(evaluateCondition(grouped, v)).toBe(true);
    expect(
      evaluateCondition(
        grouped,
        values({ 'squad.runs': 6, 'squad.win_rate': 0.5, 'result.verdict': 'ship' }),
      ),
    ).toBe(false);
  });

  it('evaluates numbers, strings and missing values', () => {
    const lt = parseCondition('squad.p_best_rolling(3) < 0.1');
    expect(evaluateCondition(lt, values({ 'squad.p_best_rolling(3)': 0.05 }))).toBe(true);
    expect(evaluateCondition(lt, values({ 'squad.p_best_rolling(3)': 0.5 }))).toBe(false);
    expect(evaluateCondition(lt, values({}))).toBe(false);
    expect(
      evaluateCondition(parseCondition('result.lift <= 0'), values({ 'result.lift': 0 })),
    ).toBe(true);
    expect(
      evaluateCondition(parseCondition('result.lift == 0.1'), values({ 'result.lift': 0.1 })),
    ).toBe(true);
    expect(
      evaluateCondition(parseCondition('result.lift != 0.1'), values({ 'result.lift': 0.2 })),
    ).toBe(true);
    expect(
      evaluateCondition(
        parseCondition('result.verdict == "ship"'),
        values({ 'result.verdict': 'ship' }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        parseCondition('result.verdict == ship'),
        values({ 'result.verdict': 'kill' }),
      ),
    ).toBe(false);
    expect(
      evaluateCondition(parseCondition('squad.runs > 3'), values({ 'squad.runs': 'many' })),
    ).toBe(false);
  });

  it('rejects anything outside the grammar instead of evaluating it', () => {
    for (const bad of [
      '',
      'squad.runs',
      'squad.runs > ',
      'squad.unknown > 1',
      'process.exit(1)',
      'squad.runs = 1',
      'squad.runs > 1 and',
      'squad.p_best_rolling < 1',
      'squad.p_best_rolling(0) < 1',
      'squad.runs(2) > 1',
      "result.verdict > 'ship'",
      'squad.runs > 1 squad.runs > 2',
      '(squad.runs > 1',
      'squad.runs > 1; drop table runs',
    ]) {
      expect(() => parseCondition(bad), bad).toThrow();
    }
    expect(() =>
      validatePolicies([PolicySchema.parse({ id: 'p', when: 'squad.runs >', then: 'pause' })]),
    ).toThrow(/policy "p"/);
    expect(() =>
      validatePolicies([PolicySchema.parse({ id: 'p', then: 'reallocate' })]),
    ).not.toThrow();
    // the policy gates carry no `when`; validation skips them
    expect(() =>
      validatePolicies([
        PolicySchema.parse({ kind: 'protected_paths', id: 'ci', paths: ['.github/**'] }),
        PolicySchema.parse({ kind: 'side_effects', id: 'fs', observe: { processes: true } }),
      ]),
    ).not.toThrow();
  });

  it('lists referenced variables once', () => {
    const expr = parseCondition(
      'squad.runs > 1 and squad.runs < 9 or squad.p_best_rolling(5) < 0.1',
    );
    expect(referencedVariables(expr).map(variableKey)).toEqual([
      'squad.runs',
      'squad.p_best_rolling(5)',
    ]);
  });
});

function makeResult(
  run: Run,
  verdict: Result['decision']['verdict'],
  variant: string | undefined,
  pBest: number,
  lift: number,
): Result {
  return {
    id: `res_${run.id.slice(4)}`,
    runId: run.id,
    method: 'bayesian',
    control: 'control',
    primaryMetricId: 'activation',
    metrics: [
      {
        metricId: 'activation',
        direction: 'increase',
        variants: [
          {
            variant: 'control',
            sessions: 10,
            successes: 5,
            mean: 0.5,
            stderr: 0.1,
            ci95: [0.3, 0.7],
          },
          {
            variant: 'treatment',
            sessions: 10,
            successes: 7,
            mean: 0.7,
            stderr: 0.1,
            ci95: [0.5, 0.9],
          },
        ],
        comparisons: [
          {
            variant: 'treatment',
            control: 'control',
            lift,
            liftCi95: [lift - 0.2, lift + 0.2],
            pBest,
            pBeatControl: pBest,
            expectedLoss: 0.01,
          },
        ],
        warnings: [],
      },
    ],
    decision: { verdict, ...(variant === undefined ? {} : { variant }), rationale: 'test' },
    calibration: { profile: 'uncalibrated-v0', note: 'test' },
    sessionsAnalyzed: 20,
    computedAt: new Date().toISOString(),
    engine: { name: 'test', version: '0' },
    kind: 'model',
    assumptions: [],
  };
}

describe('protected_paths at variant registration', () => {
  const policies = [
    PolicySchema.parse({ kind: 'protected_paths', id: 'ci', paths: ['.github/workflows/**'] }),
    PolicySchema.parse({
      kind: 'protected_paths',
      id: 'locks',
      paths: ['**/pnpm-lock.yaml'],
      approvals: [{ diffHash: 'h-approved', approvedBy: 'release-manager' }],
    }),
    PolicySchema.parse({ id: 'pause-laggards', then: 'pause' }),
  ];

  it('judges every protected_paths policy and ignores the other kinds', () => {
    const verdicts = checkProtectedPaths(
      { policies },
      { hash: 'h-approved', paths: ['pnpm-lock.yaml', 'src/a.ts'] },
    );
    expect(verdicts.map((v) => [v.policyId, v.blocked, v.touched])).toEqual([
      ['ci', false, []],
      ['locks', false, ['pnpm-lock.yaml']],
    ]);
    expect(verdicts[1]?.approval?.approvedBy).toBe('release-manager');
    expect(checkProtectedPaths({ policies: [] }, undefined)).toEqual([]);
  });

  it('throws policy_blocked naming every blocking policy', () => {
    const attempt = () =>
      enforceProtectedPaths(
        { policies },
        { hash: 'h-other', paths: ['.github/workflows/ci.yml', 'apps/web/pnpm-lock.yaml'] },
      );
    expect(attempt).toThrow(PolicyBlockedError);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'policy_blocked',
        status: 403,
        details: {
          diffHash: 'h-other',
          verdicts: [
            { policyId: 'ci', touched: ['.github/workflows/ci.yml'] },
            { policyId: 'locks', touched: ['apps/web/pnpm-lock.yaml'] },
          ],
        },
      });
    }
    expect(() => enforceProtectedPaths({ policies }, undefined)).toThrow(
      /requires a diff manifest/,
    );
  });
});

describe('variable resolution', () => {
  it('reads result and squad metrics', async () => {
    const run = { id: 'run_a', config: testConfig() } as unknown as Run;
    const result = makeResult(run, 'ship', 'treatment', 0.97, 0.3);
    const refs = referencedVariables(
      parseCondition(
        'result.verdict == ship and result.p_best > 0 and result.lift > 0 and squad.runs > 0 and squad.win_rate > 0 and squad.mean_lift > 0 and squad.p_best_rolling(2) > 0',
      ),
    );
    const resolved = await resolveVariables(refs, {
      result,
      squad: {
        id: 'sqd_1',
        slug: 'blue',
        name: 'Blue',
        status: 'active',
        allocation: 0.5,
        score: { runs: 4, wins: 3, winRate: 0.75, meanLift: 0.12, costUsd: 1 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      rolling: async (n) => n / 10,
    });
    expect(Object.fromEntries(resolved)).toEqual({
      'result.verdict': 'ship',
      'result.p_best': 0.97,
      'result.lift': 0.3,
      'squad.runs': 4,
      'squad.win_rate': 0.75,
      'squad.mean_lift': 0.12,
      'squad.p_best_rolling(2)': 0.2,
    });
    const none = await resolveVariables(refs, {});
    expect([...none.values()].every((v) => v === undefined)).toBe(true);
  });
});

describeDb('policy engine with the database', () => {
  const h = useTestServer();

  function configWith(
    policies: AgonConfig['policies'] extends (infer P)[] ? Partial<P>[] : never,
  ): AgonConfig {
    const base = testConfig();
    return AgonConfigSchema.parse({
      ...base,
      target: {
        ...base.target,
        variants: {
          control: { url: 'http://control.test' },
          treatment: { url: 'http://treatment.test', squad: 'blue' },
        },
      },
      policies,
    });
  }

  async function completedRun(
    config: AgonConfig,
    verdict: Result['decision']['verdict'],
    pBest: number,
    lift = 0.2,
  ) {
    const env = await environments.create(h.t.server.db, { config });
    const run = await runs.create(h.t.server.db, {
      environmentId: env.id,
      variants: ['control', 'treatment'],
      seed: 1,
      config,
      status: 'completed',
    });
    const finished = await runs.setStatus(h.t.server.db, run.id, 'completed');
    const result = await results.upsert(
      h.t.server.db,
      makeResult(finished, verdict, verdict === 'ship' ? 'treatment' : undefined, pBest, lift),
    );
    await runs.setResult(h.t.server.db, run.id, result.id);
    return { run: await runs.get(h.t.server.db, run.id), result };
  }

  it('pauses a laggard squad through an executed decision when approval is auto', async () => {
    const blue = await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const config = configWith([
      {
        id: 'pause-laggards',
        when: 'result.p_best < 0.2',
        then: 'pause',
        approval: 'auto',
        cooldown: '1ms',
      },
    ]);
    const { run, result } = await completedRun(config, 'kill', 0.05);
    const outcomes = await evaluatePolicies(h.t.server.context, {
      trigger: 'result.ready',
      run,
      result,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      policyId: 'pause-laggards',
      squadSlug: 'blue',
      squadId: blue.id,
    });
    expect(outcomes[0]!.decision).toMatchObject({
      kind: 'pause',
      status: 'executed',
      actor: 'auto',
      policyId: 'pause-laggards',
      squadId: blue.id,
    });
    expect(outcomes[0]!.decision!.evidence).toMatchObject({
      runIds: [run.id],
      resultIds: [result.id],
      metrics: { 'result.p_best': 0.05 },
    });
    expect((await squads.get(h.t.server.db, blue.id)).status).toBe('paused');
  });

  it('skips when the condition does not hold or the trigger differs', async () => {
    await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const config = configWith([
      { id: 'p', on: 'result.ready', when: 'result.p_best < 0.2', then: 'pause', approval: 'auto' },
    ]);
    const { run, result } = await completedRun(config, 'ship', 0.98);
    expect(
      await evaluatePolicies(h.t.server.context, { trigger: 'result.ready', run, result }),
    ).toMatchObject([{ skipped: 'not_matched' }]);
    expect(
      await evaluatePolicies(h.t.server.context, { trigger: 'run.completed', run, result }),
    ).toEqual([]);
    expect((await decisions.list(h.t.server.db)).items).toEqual([]);
  });

  it('turns only squad policies into decisions; the policy gates are not triggered here', async () => {
    await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const config = AgonConfigSchema.parse({
      ...configWith([{ id: 'notify-all', then: 'notify', approval: 'auto' }]),
      policies: [
        { id: 'notify-all', then: 'notify', approval: 'auto' },
        { kind: 'protected_paths', id: 'ci', paths: ['.github/**'] },
        { kind: 'side_effects', id: 'fs', observe: { processes: true } },
        {
          kind: 'shadow_diff',
          id: 'api',
          budget: { disallowedDiffs: 0, expiresAt: '2030-01-01T00:00:00.000Z', owner: 'api-team' },
        },
      ],
    });
    const { run, result } = await completedRun(config, 'ship', 0.98);
    const outcomes = await evaluatePolicies(h.t.server.context, {
      trigger: 'result.ready',
      run,
      result,
    });
    expect(outcomes.map((o) => o.policyId)).toEqual(['notify-all']);
    expect((await decisions.list(h.t.server.db)).items.map((d) => d.policyId)).toEqual([
      'notify-all',
    ]);
  });

  it('proposes (and does not act) when approval is human; the default for pause and kill', async () => {
    const blue = await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const config = configWith([
      { id: 'kill-losers', when: 'result.verdict == kill', then: 'kill' },
    ]);
    const { run, result } = await completedRun(config, 'kill', 0.01);
    const [outcome] = await evaluatePolicies(h.t.server.context, {
      trigger: 'result.ready',
      run,
      result,
    });
    expect(outcome!.decision).toMatchObject({
      kind: 'kill',
      status: 'proposed',
      actor: 'auto',
      squadId: blue.id,
    });
    expect((await squads.get(h.t.server.db, blue.id)).status).toBe('active');
    const approved = await h.t.request('POST', `/v1/decisions/${outcome!.decision!.id}/approve`);
    expect(approved.status).toBe(200);
    expect((await squads.get(h.t.server.db, blue.id)).status).toBe('killed');
  });

  it('honours cooldown and maxPerDay', async () => {
    const blue = await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const cooldown = configWith([
      { id: 'notify-ships', when: 'result.verdict == ship', then: 'notify', cooldown: '24h' },
    ]);
    const first = await completedRun(cooldown, 'ship', 0.99);
    expect(
      (await evaluatePolicies(h.t.server.context, { trigger: 'result.ready', ...first }))[0]!
        .decision?.status,
    ).toBe('executed');
    const second = await completedRun(cooldown, 'ship', 0.99);
    expect(
      (await evaluatePolicies(h.t.server.context, { trigger: 'result.ready', ...second }))[0],
    ).toMatchObject({ skipped: 'cooldown' });

    const capped = configWith([
      {
        id: 'notify-fast',
        when: 'result.verdict == ship',
        then: 'resume',
        cooldown: '1ms',
        maxPerDay: 2,
        approval: 'auto',
      },
    ]);
    await squads.setStatus(h.t.server.db, blue.id, 'paused');
    let made = 0;
    let skipped: string | undefined;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await squads.setStatus(h.t.server.db, blue.id, 'paused');
      const { run, result } = await completedRun(capped, 'ship', 0.99);
      const [outcome] = await evaluatePolicies(h.t.server.context, {
        trigger: 'result.ready',
        run,
        result,
      });
      if (outcome!.decision) made++;
      else skipped = outcome!.skipped;
    }
    expect(made).toBe(2);
    expect(skipped).toBe('max_per_day');
  });

  it('reallocates automatically with the policy floor and reports unknown squads', async () => {
    const blue = await squads.create(h.t.server.db, {
      slug: 'blue',
      name: 'Blue',
      score: { runs: 5, wins: 4, winRate: 0.8 },
    });
    const red = await squads.create(h.t.server.db, {
      slug: 'red',
      name: 'Red',
      score: { runs: 5, wins: 1, winRate: 0.2 },
    });
    const config = configWith([
      { id: 'reallocate', on: 'run.completed', then: 'reallocate', floor: 0.25 },
      { id: 'unknown', on: 'run.completed', then: 'notify' },
    ]);
    const altered = AgonConfigSchema.parse({
      ...config,
      target: {
        ...config.target,
        variants: {
          ...config.target.variants,
          extra: { url: 'http://extra.test', squad: 'ghost' },
        },
      },
    });
    const { run, result } = await completedRun(altered, 'ship', 0.99);
    const outcomes = await evaluatePolicies(h.t.server.context, {
      trigger: 'run.completed',
      run,
      result,
    });
    const reallocation = outcomes.find((o) => o.policyId === 'reallocate')!;
    expect(reallocation.decision).toMatchObject({
      kind: 'reallocate',
      status: 'executed',
      actor: 'auto',
      policyId: 'reallocate',
    });
    const allocation = (reallocation.decision!.payload as { allocation: Record<string, number> })
      .allocation;
    expect(Object.keys(allocation).sort()).toEqual(['blue', 'red']);
    expect(allocation['red']!).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect((await squads.get(h.t.server.db, blue.id)).allocation).toBeCloseTo(
      allocation['blue']!,
      9,
    );
    expect((await squads.get(h.t.server.db, red.id)).allocation).toBeCloseTo(allocation['red']!, 9);
    expect(
      outcomes
        .filter((o) => o.policyId === 'unknown')
        .map((o) => o.skipped ?? 'acted')
        .sort(),
    ).toEqual(['acted', 'unknown_squad']);
  });

  it("computes squad.p_best_rolling(N) from the squad's recent results", async () => {
    const blue = await squads.create(h.t.server.db, { slug: 'blue', name: 'Blue' });
    const config = configWith([
      {
        id: 'laggard',
        when: 'squad.p_best_rolling(2) < 0.2',
        then: 'pause',
        approval: 'auto',
        cooldown: '1ms',
      },
    ]);
    await completedRun(config, 'ship', 0.9);
    await new Promise((r) => setTimeout(r, 5));
    const mid = await completedRun(config, 'continue', 0.5);
    expect(
      (await evaluatePolicies(h.t.server.context, { trigger: 'result.ready', ...mid }))[0],
    ).toMatchObject({
      skipped: 'not_matched',
      values: { 'squad.p_best_rolling(2)': 0.7 },
    });
    await new Promise((r) => setTimeout(r, 5));
    const low1 = await completedRun(config, 'kill', 0.1);
    expect(
      (await evaluatePolicies(h.t.server.context, { trigger: 'result.ready', ...low1 }))[0]!.values[
        'squad.p_best_rolling(2)'
      ],
    ).toBeCloseTo(0.3, 9);
    await new Promise((r) => setTimeout(r, 5));
    const low2 = await completedRun(config, 'kill', 0.05);
    const [outcome] = await evaluatePolicies(h.t.server.context, {
      trigger: 'result.ready',
      ...low2,
    });
    expect(outcome!.values['squad.p_best_rolling(2)']).toBeCloseTo(0.075, 9);
    expect(outcome!.decision?.status).toBe('executed');
    expect((await squads.get(h.t.server.db, blue.id)).status).toBe('paused');
  });
});
