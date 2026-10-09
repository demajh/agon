import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  classifySideEffects,
  matchesGlob,
  nowIso,
  policiesOfKind,
  type AgonConfig,
  type SideEffectChange,
  type SideEffectSnapshot,
  type SideEffectsPolicy,
  type SideEffectsReport,
} from '@agon/spec';

/** Lists the running processes as pid -> command line. Injected in tests. */
export type ProcessLister = () => Promise<Record<string, string>>;

export interface SideEffectsOptions {
  /** Base directory `observe.files.root` is resolved against. */
  cwd: string;
  processes?: ProcessLister | undefined;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Content hashes of every regular file under `root`, keyed by posix path relative to it, in
 * sorted order. A symbolic link is recorded as `link:<target>` without being followed; ignored
 * globs are skipped; an unreadable file hashes as `unreadable` so a permission change still shows
 * as a modification.
 */
export async function snapshotFileTree(
  root: string,
  ignore: readonly string[] = [],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const base = resolve(root);
  const ignored = (path: string): boolean => ignore.some((glob) => matchesGlob(path, glob, '/'));
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name);
      const path = toPosix(relative(base, full));
      if (entry.isSymbolicLink()) {
        // Recorded by target and never followed: creating or retargeting a link is a change.
        if (!ignored(path)) out[path] = `link:${await readlink(full).catch(() => 'unreadable')}`;
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignored(`${path}/`) && !ignored(path)) await walk(full);
        continue;
      }
      if (!entry.isFile() || ignored(path)) continue;
      try {
        out[path] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
      } catch {
        out[path] = 'unreadable';
      }
    }
  };
  await walk(base);
  return out;
}

/**
 * `ps -eo pid=,args=` on unix; rejects on platforms without `ps`. The `ps` process lists itself,
 * under a new pid every time, so its own entry is dropped: otherwise every comparison would report
 * the observer arriving and leaving.
 */
export const listProcesses: ProcessLister = () =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(
      'ps',
      ['-eo', 'pid=,args='],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const out: Record<string, string> = {};
        for (const line of stdout.split('\n')) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m && Number(m[1]) !== child.pid) out[m[1] as string] = (m[2] as string).trim();
        }
        resolvePromise(out);
      },
    );
  });

/**
 * Snapshot, call, snapshot for one `side_effects` policy: `before()` records the places allowed
 * to change, `after(before)` diffs them against the expected list. The network is not observed.
 */
export class SideEffectsGuard {
  readonly scope: SideEffectsPolicy['scope'];
  private readonly processes: ProcessLister;

  constructor(
    readonly policy: SideEffectsPolicy,
    private readonly options: SideEffectsOptions,
  ) {
    this.scope = policy.scope;
    this.processes = options.processes ?? listProcesses;
  }

  async snapshot(): Promise<SideEffectSnapshot> {
    const files = this.policy.observe.files;
    const snapshot: SideEffectSnapshot = {
      takenAt: nowIso(),
      files:
        files === undefined
          ? {}
          : await snapshotFileTree(resolve(this.options.cwd, files.root), files.ignore),
    };
    if (this.policy.observe.processes) snapshot.processes = await this.processes();
    return snapshot;
  }

  before(): Promise<SideEffectSnapshot> {
    return this.snapshot();
  }

  async after(before: SideEffectSnapshot): Promise<SideEffectsReport> {
    return classifySideEffects(this.policy, before, await this.snapshot());
  }
}

/** One guard per `side_effects` policy in the config. */
export function sideEffectsGuards(
  config: AgonConfig,
  options: SideEffectsOptions,
): SideEffectsGuard[] {
  return policiesOfKind(config.policies, 'side_effects').map(
    (policy) => new SideEffectsGuard(policy, options),
  );
}

const MAX_LISTED_CHANGES = 50;

function describeChange(change: SideEffectChange): string {
  return `${change.change}:${change.path}`;
}

/** The `$agon_side_effects` event payload for one report. */
export function sideEffectsEventProperties(
  report: SideEffectsReport,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    policy: report.policyId,
    scope: report.scope,
    observed: report.observed,
    not_observable: [...report.notObservable],
    expected_list_size: report.expectedListSize,
    changes: report.changes.length,
    expected: report.expected.length,
    unexpected: report.unexpected.length,
    unexpected_changes: report.unexpected.slice(0, MAX_LISTED_CHANGES).map(describeChange),
    ...extra,
  };
}
