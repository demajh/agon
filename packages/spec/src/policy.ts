import { z } from 'zod';
import type { Materiality } from './analysis.js';
import {
  DurationSchema,
  IdSchema,
  SlugSchema,
  TimestampSchema,
  UnitSchema,
  canonicalJson,
  hashValue,
} from './common.js';

// --- squad policies ------------------------------------------------------------------------------

export const PolicyActionSchema = z.enum(['reallocate', 'pause', 'resume', 'kill', 'notify']);
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicyTriggerSchema = z.enum(['run.completed', 'result.ready', 'schedule']);

/** A governance policy: when a result or run matches, act on the credited squads. */
export const SquadPolicySchema = z.object({
  kind: z
    .literal('squad')
    .default('squad')
    .describe(
      'The default kind: a squad governance policy (reallocate, pause, resume, kill, notify)',
    ),
  id: SlugSchema,
  name: z.string().optional(),
  on: PolicyTriggerSchema.default('result.ready'),
  when: z
    .string()
    .optional()
    .describe(
      'Boolean expression over squad and result metrics, e.g. "squad.p_best_rolling(5) < 0.10"',
    ),
  then: PolicyActionSchema,
  method: z.enum(['thompson']).default('thompson'),
  floor: UnitSchema.default(0.1).describe('Minimum allocation any active squad keeps'),
  approval: z
    .enum(['auto', 'human'])
    .optional()
    .describe('Defaults to human for pause/kill, auto otherwise'),
  cooldown: DurationSchema.default('24h'),
  maxPerDay: z.number().int().positive().default(5),
});
export type SquadPolicy = z.infer<typeof SquadPolicySchema>;

export function policyApproval(p: Pick<SquadPolicy, 'approval' | 'then'>): 'auto' | 'human' {
  return p.approval ?? (p.then === 'kill' || p.then === 'pause' ? 'human' : 'auto');
}

// --- glob matching, shared by the gates -----------------------------------------------------------

/**
 * Where `*` stops: `/` for file paths, `.` for dotted field paths, `none` for free text such as a
 * process command line (`*` then matches anything, slashes included).
 */
export type GlobSeparator = '/' | '.' | 'none';

/**
 * Turns a glob into a RegExp: `*` matches any run of characters except the separator, `**` any
 * run including it, `?` one character other than the separator.
 */
export function globToRegExp(glob: string, separator: GlobSeparator = '/'): RegExp {
  const any = separator === 'none' ? '.' : `[^${separator === '/' ? '\\/' : '\\.'}]`;
  const sep = separator === '/' ? '\\/' : separator === '.' ? '\\.' : '';
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` also matches the empty prefix, so `**/foo` matches `foo`.
        if (separator !== 'none' && glob[i + 1] === separator) {
          i++;
          out += `(?:.*${sep})?`;
        } else out += '.*';
      } else out += `${any}*`;
    } else if (ch === '?') out += any;
    else out += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

export function matchesGlob(value: string, glob: string, separator: GlobSeparator = '/'): boolean {
  return globToRegExp(glob, separator).test(value);
}

// --- protected_paths -----------------------------------------------------------------------------

/** An approval is recorded against the hash of a diff, never against a variant. */
export const DiffApprovalSchema = z.object({
  diffHash: z
    .string()
    .min(1)
    .describe(
      'sha256 of the exact diff text the approval covers (`agon gate protected-paths --json` prints it)',
    ),
  approvedBy: z.string().min(1).describe('Who approved the diff'),
  approvedAt: TimestampSchema.optional(),
  note: z.string().optional().describe('Why the change to a protected path is acceptable'),
});
export type DiffApproval = z.infer<typeof DiffApprovalSchema>;

/** What a variant registration says about the change it deploys. */
export const DiffManifestSchema = z.object({
  hash: z.string().min(1).describe('sha256 of the diff text; approvals are matched against it'),
  paths: z.array(z.string().min(1)).describe('Repository-relative paths the diff touches'),
  base: z.string().optional().describe('Base commit or ref'),
  head: z.string().optional().describe('Head commit or ref'),
});
export type DiffManifest = z.infer<typeof DiffManifestSchema>;

export const ProtectedPathsPolicySchema = z.object({
  kind: z.literal('protected_paths'),
  id: SlugSchema,
  name: z.string().optional(),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Globs (`*`, `**`, `?`) of paths a less-sandboxed process will later read and act on: CI workflow files, MCP server definitions, deploy manifests, lockfiles. A diff that touches one is blocked unless an approval exists for that exact diff hash',
    ),
  approvals: z
    .array(DiffApprovalSchema)
    .default([])
    .describe('Hand-written approvals, recorded against the diff hash, not the variant'),
  requireManifest: z
    .boolean()
    .default(true)
    .describe(
      'Block a variant registration that carries no diff manifest. With false the check cannot run and the registration is let through; the gate is then advisory',
    ),
});
export type ProtectedPathsPolicy = z.infer<typeof ProtectedPathsPolicySchema>;

export interface ProtectedPathsVerdict {
  policyId: string;
  /** Listed paths the diff touches, in manifest order. */
  touched: string[];
  approval?: DiffApproval | undefined;
  blocked: boolean;
  /** `checked` when a manifest was evaluated, `unchecked` when none was given and the policy allows that. */
  enforcement: 'checked' | 'unchecked';
  reason: string;
}

/** The listed paths among `paths`, in order, without duplicates. */
export function protectedPathsTouched(
  policy: Pick<ProtectedPathsPolicy, 'paths'>,
  paths: readonly string[],
): string[] {
  const patterns = policy.paths.map((glob) => globToRegExp(glob, '/'));
  const out: string[] = [];
  for (const path of paths) {
    if (out.includes(path)) continue;
    if (patterns.some((re) => re.test(path))) out.push(path);
  }
  return out;
}

export function diffApproval(
  policy: Pick<ProtectedPathsPolicy, 'approvals'>,
  diffHash: string,
): DiffApproval | undefined {
  return policy.approvals.find((a) => a.diffHash === diffHash);
}

/** Decides whether a diff may register a variant under this policy. */
export function evaluateProtectedPaths(
  policy: ProtectedPathsPolicy,
  manifest: DiffManifest | undefined,
): ProtectedPathsVerdict {
  if (manifest === undefined) {
    return policy.requireManifest
      ? {
          policyId: policy.id,
          touched: [],
          blocked: true,
          enforcement: 'checked',
          reason: `policy "${policy.id}" requires a diff manifest (hash and touched paths) on every variant registration`,
        }
      : {
          policyId: policy.id,
          touched: [],
          blocked: false,
          enforcement: 'unchecked',
          reason: `policy "${policy.id}": no diff manifest given and requireManifest is false; protected paths were not checked`,
        };
  }
  const touched = protectedPathsTouched(policy, manifest.paths);
  if (touched.length === 0) {
    return {
      policyId: policy.id,
      touched,
      blocked: false,
      enforcement: 'checked',
      reason: `policy "${policy.id}": the diff touches no protected path`,
    };
  }
  const approval = diffApproval(policy, manifest.hash);
  if (approval === undefined) {
    return {
      policyId: policy.id,
      touched,
      blocked: true,
      enforcement: 'checked',
      reason: `policy "${policy.id}": diff ${manifest.hash.slice(0, 12)} touches protected ${touched.join(', ')} and no approval is recorded for that diff hash`,
    };
  }
  return {
    policyId: policy.id,
    touched,
    approval,
    blocked: false,
    enforcement: 'checked',
    reason: `policy "${policy.id}": diff ${manifest.hash.slice(0, 12)} touches protected ${touched.join(', ')}; approved by ${approval.approvedBy}`,
  };
}

// --- side_effects --------------------------------------------------------------------------------

export const SideEffectsScopeSchema = z.enum(['session', 'tool_call']);
export type SideEffectsScope = z.infer<typeof SideEffectsScopeSchema>;

/** The observation points: the file tree (observed), the process table (observed), the network (not observable). */
export const SIDE_EFFECT_OBSERVATION_POINTS = ['files', 'processes'] as const;
export const SIDE_EFFECT_NOT_OBSERVABLE = ['network'] as const;

export const SideEffectsPolicySchema = z.object({
  kind: z.literal('side_effects'),
  id: SlugSchema,
  name: z.string().optional(),
  scope: SideEffectsScopeSchema.default('session').describe(
    'Snapshot before and after each session, or before and after each tool call',
  ),
  observe: z
    .object({
      files: z
        .object({
          root: z
            .string()
            .min(1)
            .describe('Directory to snapshot, relative to the working directory'),
          ignore: z
            .array(z.string().min(1))
            .default(['**/node_modules/**', '**/.git/**'])
            .describe('Globs never snapshotted'),
        })
        .optional()
        .describe('Snapshot the file tree under root: a content hash per file'),
      processes: z
        .boolean()
        .default(false)
        .describe(
          'Snapshot the process table (unix `ps`); entries are matched as "proc:<command>"',
        ),
    })
    .describe(
      'Where to look. The file tree and the process table are observation points; the network is not observable and is reported as such',
    ),
  expected: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Globs of paths (and "proc:<command>" entries) allowed to change. The size of this list is recorded with every report so its growth can be measured',
    ),
});
export type SideEffectsPolicy = z.infer<typeof SideEffectsPolicySchema>;

/** What the places allowed to change looked like at one moment. */
export const SideEffectSnapshotSchema = z.object({
  takenAt: TimestampSchema,
  files: z.record(z.string(), z.string()).describe('Path relative to root -> content hash'),
  processes: z.record(z.string(), z.string()).optional().describe('pid -> command'),
});
export type SideEffectSnapshot = z.infer<typeof SideEffectSnapshotSchema>;

export const SideEffectChangeSchema = z.object({
  kind: z.enum(['file', 'process']),
  path: z
    .string()
    .min(1)
    .describe('A file path relative to the observed root, or "proc:<command>" for a process'),
  change: z.enum(['added', 'removed', 'modified']),
});
export type SideEffectChange = z.infer<typeof SideEffectChangeSchema>;

export interface SideEffectsReport {
  policyId: string;
  scope: SideEffectsScope;
  observed: ('files' | 'processes')[];
  notObservable: readonly ['network'];
  expectedListSize: number;
  changes: SideEffectChange[];
  expected: SideEffectChange[];
  unexpected: SideEffectChange[];
}

/**
 * Every path whose content hash differs between the snapshots, plus process arrivals and exits. A
 * pid whose command line changed (an exec) counts as the old process leaving and a new one arriving.
 */
export function diffSnapshots(
  before: SideEffectSnapshot,
  after: SideEffectSnapshot,
): SideEffectChange[] {
  const changes: SideEffectChange[] = [];
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const path of [...paths].sort()) {
    const a = before.files[path];
    const b = after.files[path];
    if (a === undefined) changes.push({ kind: 'file', path, change: 'added' });
    else if (b === undefined) changes.push({ kind: 'file', path, change: 'removed' });
    else if (a !== b) changes.push({ kind: 'file', path, change: 'modified' });
  }
  if (before.processes !== undefined || after.processes !== undefined) {
    const was = before.processes ?? {};
    const is = after.processes ?? {};
    for (const pid of Object.keys(was).sort()) {
      if (is[pid] !== was[pid])
        changes.push({ kind: 'process', path: `proc:${was[pid]}`, change: 'removed' });
    }
    for (const pid of Object.keys(is).sort()) {
      if (was[pid] !== is[pid])
        changes.push({ kind: 'process', path: `proc:${is[pid]}`, change: 'added' });
    }
  }
  return changes;
}

const PROCESS_PREFIX = 'proc:';

/**
 * Whether a change is on the expected list. File globs (`*` stops at `/`) match file paths;
 * `proc:` globs match process command lines, where `*` matches anything, slashes included.
 */
export function expectedChange(expected: readonly string[]): (change: SideEffectChange) => boolean {
  const files = expected
    .filter((glob) => !glob.startsWith(PROCESS_PREFIX))
    .map((glob) => globToRegExp(glob, '/'));
  const processes = expected
    .filter((glob) => glob.startsWith(PROCESS_PREFIX))
    .map((glob) => globToRegExp(glob.slice(PROCESS_PREFIX.length), 'none'));
  return (change) =>
    change.kind === 'process'
      ? processes.some((re) => re.test(change.path.slice(PROCESS_PREFIX.length)))
      : files.some((re) => re.test(change.path));
}

/** Snapshot, call, snapshot: the changes against the expected list, with the list's size recorded. */
export function classifySideEffects(
  policy: SideEffectsPolicy,
  before: SideEffectSnapshot,
  after: SideEffectSnapshot,
): SideEffectsReport {
  const changes = diffSnapshots(before, after);
  const isExpected = expectedChange(policy.expected);
  const expected: SideEffectChange[] = [];
  const unexpected: SideEffectChange[] = [];
  for (const change of changes) (isExpected(change) ? expected : unexpected).push(change);
  const observed: ('files' | 'processes')[] = [];
  if (policy.observe.files !== undefined) observed.push('files');
  if (policy.observe.processes) observed.push('processes');
  return {
    policyId: policy.id,
    scope: policy.scope,
    observed,
    notObservable: SIDE_EFFECT_NOT_OBSERVABLE,
    expectedListSize: policy.expected.length,
    changes,
    expected,
    unexpected,
  };
}

// --- shadow_diff ---------------------------------------------------------------------------------

export const ShadowFieldRuleSchema = z.enum(['allow', 'disallow', 'semantic']);
export type ShadowFieldRule = z.infer<typeof ShadowFieldRuleSchema>;

export const ShadowExceptionSchema = z.object({
  field: z.string().min(1).describe('Dotted path of the field the exception covers'),
  diffHash: z.string().min(1).describe('The diffHash the gate reported for the disallowed diff'),
  owner: z.string().min(1).describe('Who owns the exception and retires it'),
  expiresAt: TimestampSchema.describe('After this the exception no longer covers the diff'),
  reason: z.string().optional(),
});
export type ShadowException = z.infer<typeof ShadowExceptionSchema>;

/** (field, diffHash) pairs approved more than once: a contract change that was not made explicitly. */
export function repeatedApprovals(
  policy: Pick<ShadowDiffPolicy, 'exceptions'>,
): { field: string; diffHash: string; count: number }[] {
  const counts = new Map<string, { field: string; diffHash: string; count: number }>();
  for (const e of policy.exceptions) {
    const key = `${e.field}\u0000${e.diffHash}`;
    const entry = counts.get(key) ?? { field: e.field, diffHash: e.diffHash, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].filter((e) => e.count > 1);
}

export const ShadowDiffPolicySchema = z
  .object({
    kind: z.literal('shadow_diff'),
    id: SlugSchema,
    name: z.string().optional(),
    contract: z
      .object({
        fields: z
          .record(z.string(), ShadowFieldRuleSchema)
          .default({})
          .describe(
            'Dotted field paths (globs with `*` per segment, `**` across segments) -> allow (skipped), disallow (diffed), semantic (a judge decides whether the difference is one of meaning)',
          ),
        default: z
          .enum(['allow', 'disallow'])
          .default('allow')
          .describe(
            'Rule for fields the contract does not list and the materiality boundary does not name',
          ),
      })
      .prefault({})
      .describe('Which output fields may differ between control and variant, and how'),
    budget: z
      .object({
        disallowedDiffs: z
          .number()
          .int()
          .nonnegative()
          .describe('Disallowed diffs tolerated before the gate fails'),
        expiresAt: TimestampSchema.describe('After this the budget is void and the gate fails'),
        owner: z.string().min(1).describe('Who owns the budget, renews it or retires it'),
      })
      .describe('A count of disallowed diffs with an expiry and a named owner'),
    exceptions: z
      .array(ShadowExceptionSchema)
      .default([])
      .describe('Hand-written, each with an owner and an expiry; a repeated one is a config error'),
  })
  .superRefine((policy, ctx) => {
    for (const r of repeatedApprovals(policy)) {
      ctx.addIssue({
        code: 'custom',
        path: ['exceptions'],
        message: `"${r.field}" diff ${r.diffHash.slice(0, 12)} is approved ${r.count} times: a repeated approval of the same disallowed diff is a contract change; set contract.fields["${r.field}"] explicitly instead`,
      });
    }
  });
export type ShadowDiffPolicy = z.infer<typeof ShadowDiffPolicySchema>;

export interface ShadowFieldDiff {
  field: string;
  rule: ShadowFieldRule;
  control: unknown;
  variant: unknown;
  diffHash: string;
}

export interface ShadowDiffReport {
  policyId: string;
  /** Fields that differ and the contract does not allow to, not covered by a live exception. */
  disallowed: ShadowFieldDiff[];
  /** Fields that differ where the contract allows a semantic difference: consult the judge. */
  semantic: ShadowFieldDiff[];
  /** Disallowed diffs covered by a live exception. */
  excepted: { diff: ShadowFieldDiff; exception: ShadowException }[];
  /** Fields that differ and the contract allows to; never diffed further. */
  skipped: string[];
  expiredExceptions: ShadowException[];
  budget: {
    limit: number;
    used: number;
    remaining: number;
    expired: boolean;
    owner: string;
    expiresAt: string;
  };
  withinBudget: boolean;
}

/**
 * Leaves of a JSON value as dotted paths; array elements by index. Empty arrays and objects are
 * leaves themselves; `undefined` members are absent, as they are in JSON.
 */
export function flattenFields(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) return;
    if (Array.isArray(v)) {
      if (v.length === 0) out.set(path, v);
      v.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) out.set(path, v);
      for (const [k, item] of entries) walk(item, path ? `${path}.${k}` : k);
    } else out.set(path, v);
  };
  walk(value, prefix);
  return out;
}

function ruleFor(
  field: string,
  policy: ShadowDiffPolicy,
  materiality: Pick<Materiality, 'fields'>,
): ShadowFieldRule {
  const explicit = policy.contract.fields[field];
  if (explicit !== undefined) return explicit;
  for (const [pattern, rule] of Object.entries(policy.contract.fields)) {
    if (matchesGlob(field, pattern, '.')) return rule;
  }
  if (materiality.fields.some((m) => m === field || matchesGlob(field, m, '.'))) return 'disallow';
  return policy.contract.default;
}

/**
 * The identity of one disallowed diff: the field and both values (a side where the field is absent
 * hashes as absent). Exceptions name it, so an approval covers that exact difference only.
 */
export function shadowDiffHash(field: string, control: unknown, variant: unknown): string {
  return hashValue({ field, control, variant });
}

/**
 * Compares control and variant outputs schema-first: fields the contract allows to differ are
 * skipped, fields it does not are diffed, and fields marked semantic are returned for a judge.
 * Disallowed diffs are charged against the budget unless a live exception covers them.
 */
export function shadowDiff(
  policy: ShadowDiffPolicy,
  materiality: Pick<Materiality, 'fields'>,
  control: unknown,
  variant: unknown,
  now: Date,
): ShadowDiffReport {
  const a = flattenFields(control);
  const b = flattenFields(variant);
  const fields = [...new Set([...a.keys(), ...b.keys()])].sort();
  const live = policy.exceptions.filter((e) => Date.parse(e.expiresAt) > now.getTime());
  const expiredExceptions = policy.exceptions.filter(
    (e) => Date.parse(e.expiresAt) <= now.getTime(),
  );
  const report: ShadowDiffReport = {
    policyId: policy.id,
    disallowed: [],
    semantic: [],
    excepted: [],
    skipped: [],
    expiredExceptions,
    budget: {
      limit: policy.budget.disallowedDiffs,
      used: 0,
      remaining: policy.budget.disallowedDiffs,
      expired: Date.parse(policy.budget.expiresAt) <= now.getTime(),
      owner: policy.budget.owner,
      expiresAt: policy.budget.expiresAt,
    },
    withinBudget: false,
  };
  for (const field of fields) {
    const left = a.get(field);
    const right = b.get(field);
    // A field present on one side only is a difference (`control` or `variant` is then undefined).
    if (a.has(field) === b.has(field) && canonicalJson(left) === canonicalJson(right)) continue;
    const rule = ruleFor(field, policy, materiality);
    if (rule === 'allow') {
      report.skipped.push(field);
      continue;
    }
    const diff: ShadowFieldDiff = {
      field,
      rule,
      control: left,
      variant: right,
      diffHash: shadowDiffHash(field, left, right),
    };
    if (rule === 'semantic') {
      report.semantic.push(diff);
      continue;
    }
    const exception = live.find((e) => e.field === field && e.diffHash === diff.diffHash);
    if (exception) report.excepted.push({ diff, exception });
    else report.disallowed.push(diff);
  }
  report.budget.used = report.disallowed.length;
  report.budget.remaining = Math.max(0, report.budget.limit - report.budget.used);
  report.withinBudget = !report.budget.expired && report.budget.used <= report.budget.limit;
  return report;
}

/**
 * Consults a judge for the semantic fields, and only for them: a difference the judge calls
 * material becomes a disallowed diff (charged against the budget like any other, keeping its
 * `semantic` rule so the report shows a judge decided it), one it calls immaterial is skipped.
 */
export async function judgeSemanticDiffs(
  report: ShadowDiffReport,
  judge: (diff: ShadowFieldDiff) => Promise<boolean>,
): Promise<ShadowDiffReport> {
  const out: ShadowDiffReport = { ...report, disallowed: [...report.disallowed], semantic: [] };
  for (const diff of report.semantic) {
    if (await judge(diff)) out.disallowed.push(diff);
    else out.skipped = [...out.skipped, diff.field];
  }
  out.budget = {
    ...out.budget,
    used: out.disallowed.length,
    remaining: Math.max(0, out.budget.limit - out.disallowed.length),
  };
  out.withinBudget = !out.budget.expired && out.budget.used <= out.budget.limit;
  return out;
}

// --- the union -----------------------------------------------------------------------------------

export const GatePolicySchema = z.discriminatedUnion('kind', [
  ProtectedPathsPolicySchema,
  SideEffectsPolicySchema,
  ShadowDiffPolicySchema,
]);
export type GatePolicy = z.infer<typeof GatePolicySchema>;

/** `policies[]`: squad governance policies (the default kind) and the three policy gates. */
export const PolicySchema = z.discriminatedUnion('kind', [
  SquadPolicySchema,
  ProtectedPathsPolicySchema,
  SideEffectsPolicySchema,
  ShadowDiffPolicySchema,
]);
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;
export type PolicyKind = Policy['kind'];

export function isSquadPolicy(p: Policy): p is SquadPolicy {
  return p.kind === 'squad';
}

export function squadPolicies(policies: readonly Policy[]): SquadPolicy[] {
  return policies.filter(isSquadPolicy);
}

export function policiesOfKind<K extends PolicyKind>(
  policies: readonly Policy[],
  kind: K,
): Extract<Policy, { kind: K }>[] {
  return policies.filter((p): p is Extract<Policy, { kind: K }> => p.kind === kind);
}

// --- decisions -----------------------------------------------------------------------------------

export const DecisionStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'executed',
  'failed',
]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/** Append-only record of every governance action Agon proposes or takes. */
export const DecisionSchema = z.object({
  id: IdSchema,
  kind: PolicyActionSchema,
  status: DecisionStatusSchema,
  squadId: IdSchema.optional(),
  policyId: SlugSchema.optional(),
  actor: z.enum(['auto', 'human']),
  rationale: z.string().min(1),
  evidence: z
    .object({
      runIds: z.array(IdSchema).default([]),
      resultIds: z.array(IdSchema).default([]),
      metrics: z.record(z.string(), z.number()).default({}),
    })
    .prefault({}),
  payload: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Action parameters, e.g. the new allocation'),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  executedAt: TimestampSchema.optional(),
  error: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;
