import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '@agon/spec';

/** How to start `agon-stats`: a command plus leading arguments. */
export interface StatsBinary {
  command: string;
  args: string[];
  /** Where it came from, for diagnostics. */
  source: 'env' | 'path' | 'uv-project';
}

export const STATS_BIN_ENV = 'AGON_STATS_BIN';

export interface ResolveBinaryOptions {
  env?: Record<string, string | undefined>;
  /** Extra directories to look for a `packages/stats` uv project in, before the built-in guess. */
  projectDirs?: string[];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The monorepo's `packages/stats` relative to this module (dist/ or src/), when running from source. */
export function monorepoStatsDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '../../stats');
  return existsSync(join(candidate, 'pyproject.toml')) ? candidate : undefined;
}

/**
 * Finds `agon-stats`: `$AGON_STATS_BIN` (a command line), then `agon-stats` on PATH, then
 * `uv run --project <packages/stats> agon-stats` inside a checkout. Throws ConfigError otherwise.
 */
export function resolveStatsBinary(options: ResolveBinaryOptions = {}): StatsBinary {
  const env = options.env ?? process.env;
  const fromEnv = env[STATS_BIN_ENV]?.trim();
  if (fromEnv) {
    const [command, ...args] = fromEnv.split(/\s+/);
    return { command: command as string, args, source: 'env' };
  }
  const onPath = findOnPath('agon-stats', env);
  if (onPath) return { command: onPath, args: [], source: 'path' };
  const uv = findOnPath('uv', env);
  if (uv) {
    const projects = [...(options.projectDirs ?? []), monorepoStatsDir()].filter(
      (d): d is string => !!d,
    );
    const project = projects.find((d) => existsSync(join(d, 'pyproject.toml')));
    if (project)
      return {
        command: uv,
        args: ['run', '--quiet', '--project', project, 'agon-stats'],
        source: 'uv-project',
      };
  }
  throw new ConfigError(
    'agon-stats not found. Install it (`pip install agon-stats` or `uv tool install agon-stats`), or set AGON_STATS_BIN to the command that runs it.',
  );
}
