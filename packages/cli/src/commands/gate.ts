import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ConfigError,
  ValidationError,
  evaluateProtectedPaths,
  isAgonError,
  judgeSemanticDiffs,
  policiesOfKind,
  readAgonConfig,
  sha256Hex,
  shadowDiff,
  type AgonConfig,
  type DiffManifest,
  type ProtectedPathsVerdict,
  type ShadowDiffReport,
} from '@agon/spec';
import type { Output } from '../output.js';

function message(error: unknown): string {
  return isAgonError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

function fail(out: Output, error: unknown): number {
  if (out.options.json) out.json({ ok: false, error: message(error) });
  else out.fail(message(error));
  return 1;
}

function loadConfig(file: string): AgonConfig {
  return readAgonConfig(resolve(file), { env: process.env });
}

// --- protected_paths -----------------------------------------------------------------------------

/**
 * The git arguments that define the diff text an approval's hash covers: the change on `head`
 * since its merge base with `base` (three dots), without colour, external diff drivers or rename
 * detection (a rename shows as a removal and an addition, so moving a file out of a protected
 * path touches it), with full blob ids and binary contents.
 */
export const DIFF_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-renames',
  '--full-index',
  '--binary',
];

/** The diff manifest of `base...head` in `repo`: sha256 of the canonical diff text and the paths. */
export function diffManifest(repo: string, base: string, head: string): DiffManifest {
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const range = `${base}...${head}`;
  const text = git([...DIFF_ARGS, range]);
  const paths = git(['diff', '--name-only', '-z', '--no-renames', range])
    .split('\0')
    .filter((path) => path.length > 0);
  return { hash: sha256Hex(text), paths, base, head };
}

export interface ProtectedPathsOptions {
  file: string;
  base: string;
  head?: string | undefined;
  repo?: string | undefined;
}

/**
 * Computes the diff manifest of `base...head` and judges it against every `protected_paths`
 * policy of the config. Exit 0 when nothing is blocked, 1 when a policy blocks it or on error.
 * The manifest (`--json`) is what a variant registration sends as `diff`.
 */
export function protectedPathsCommand(out: Output, options: ProtectedPathsOptions): number {
  let manifest: DiffManifest;
  let verdicts: ProtectedPathsVerdict[];
  try {
    const config = loadConfig(options.file);
    const policies = policiesOfKind(config.policies, 'protected_paths');
    manifest = diffManifest(resolve(options.repo ?? '.'), options.base, options.head ?? 'HEAD');
    verdicts = policies.map((policy) => evaluateProtectedPaths(policy, manifest));
  } catch (error) {
    return fail(out, error);
  }
  const blocked = verdicts.some((v) => v.blocked);
  if (out.options.json) {
    out.json({ ok: !blocked, manifest, verdicts });
    return blocked ? 1 : 0;
  }
  out.heading(
    `diff ${manifest.base}...${manifest.head}: ${manifest.paths.length} path(s), sha256 ${manifest.hash}`,
  );
  if (verdicts.length === 0) out.warn('the config has no protected_paths policy');
  for (const verdict of verdicts) {
    if (verdict.blocked) out.fail(verdict.reason);
    else out.ok(verdict.reason);
  }
  return blocked ? 1 : 0;
}

// --- shadow_diff ---------------------------------------------------------------------------------

export interface ShadowDiffOptions {
  file: string;
  control: string;
  variant: string;
  policy?: string | undefined;
  now?: Date | undefined;
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(resolve(path), 'utf8');
  } catch (error) {
    throw new ValidationError(`cannot read the ${what} output ${path}: ${message(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ValidationError(`the ${what} output ${path} is not JSON: ${message(error)}`);
  }
}

/**
 * Compares a control output with a variant output under a `shadow_diff` policy and the config's
 * materiality boundary. The CLI has no judge, so a difference in a `semantic` field is charged
 * as material; the library's `judgeSemanticDiffs` takes a real one. Exit 0 within budget, else 1.
 */
export async function shadowDiffCommand(out: Output, options: ShadowDiffOptions): Promise<number> {
  let report: ShadowDiffReport;
  try {
    const config = loadConfig(options.file);
    const policies = policiesOfKind(config.policies, 'shadow_diff');
    const policy =
      options.policy === undefined
        ? policies.length === 1
          ? policies[0]
          : undefined
        : policies.find((p) => p.id === options.policy);
    if (policy === undefined) {
      throw new ConfigError(
        options.policy === undefined
          ? `name the shadow_diff policy with --policy (the config has ${policies.length})`
          : `no shadow_diff policy "${options.policy}" in ${options.file}`,
      );
    }
    const unjudged = shadowDiff(
      policy,
      config.analysis.materiality,
      readJson(options.control, 'control'),
      readJson(options.variant, 'variant'),
      options.now ?? new Date(),
    );
    report = await judgeSemanticDiffs(unjudged, async () => true);
  } catch (error) {
    return fail(out, error);
  }
  if (out.options.json) {
    out.json({ ok: report.withinBudget, report });
    return report.withinBudget ? 0 : 1;
  }
  const { budget } = report;
  out.heading(
    `shadow_diff ${report.policyId}: ${budget.used} disallowed diff(s) of a budget of ${budget.limit} (owner ${budget.owner}, expires ${budget.expiresAt}${budget.expired ? ', EXPIRED' : ''})`,
  );
  for (const diff of report.disallowed) {
    const note =
      diff.rule === 'semantic' ? ' (semantic field; no judge here, counted as material)' : '';
    out.fail(
      `${diff.field}: ${JSON.stringify(diff.control)} -> ${JSON.stringify(diff.variant)}  diffHash ${diff.diffHash}${note}`,
    );
  }
  for (const { diff, exception } of report.excepted) {
    out.warn(`${diff.field}: excepted until ${exception.expiresAt} (owner ${exception.owner})`);
  }
  for (const expired of report.expiredExceptions) {
    out.warn(
      `exception for ${expired.field} expired ${expired.expiresAt} (owner ${expired.owner})`,
    );
  }
  if (report.skipped.length > 0)
    out.text(out.dim(`  allowed to differ: ${report.skipped.join(', ')}`));
  if (report.withinBudget) out.ok('within budget');
  else out.fail(budget.expired ? 'the budget has expired' : 'over budget');
  return report.withinBudget ? 0 : 1;
}
