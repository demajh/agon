import { resolve } from 'node:path';
import { API_KEY_ROLES, type ApiKeyRole } from '@agon/db';
import { LLM_MODES, type LlmMode } from '@agon/llm';
import { ConfigError, SLUG_RE } from '@agon/spec';

export const SERVER_ROLES = ['all', 'api', 'worker'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

export const DEFAULT_PORT = 4000;
export const DEFAULT_DATA_DIR = '.agon/data';

/** A key configured through `AGON_API_KEYS`, checked before the `api_keys` table. */
export interface BootstrapKey {
  key: string;
  role: ApiKeyRole;
  /** Required for `squad` keys: the slug of the squad the key acts for. */
  squadSlug?: string;
}

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  host: string;
  role: ServerRole;
  bootstrapKeys: BootstrapKey[];
  /** Absolute. Screenshots live under `<dataDir>/screenshots/<runId>/<stepId>.png`. */
  dataDir: string;
  llmMode: LlmMode | undefined;
  /** Outbound webhook target for `run.completed`, `result.ready`, `decision.*`. */
  webhookUrl: string | undefined;
  logLevel: string;
  /** Schema pg-boss keeps its tables in. */
  queueSchema: string;
  /** Sessions run in parallel per run when the config does not say. */
  concurrency: number | undefined;
}

export type Env = Record<string, string | undefined>;

/**
 * Parses `AGON_API_KEYS`: a comma-separated list of `key:role[:squadSlug]`. Squad keys need a
 * squad slug; other roles must not carry one. Keys are at least 16 characters.
 */
export function parseBootstrapKeys(value: string | undefined): BootstrapKey[] {
  if (!value || value.trim() === '') return [];
  const out: BootstrapKey[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [key, role, squadSlug, ...rest] = entry.split(':');
    if (!key || !role || rest.length > 0) {
      throw new ConfigError(`AGON_API_KEYS: expected "key:role[:squadSlug]", got "${entry}"`);
    }
    if (key.length < 16) {
      throw new ConfigError('AGON_API_KEYS: keys must be at least 16 characters');
    }
    if (!(API_KEY_ROLES as readonly string[]).includes(role)) {
      throw new ConfigError(
        `AGON_API_KEYS: unknown role "${role}" (expected ${API_KEY_ROLES.join(', ')})`,
      );
    }
    if (role === 'squad') {
      if (!squadSlug || !SLUG_RE.test(squadSlug)) {
        throw new ConfigError('AGON_API_KEYS: squad keys need a squad slug: "key:squad:<slug>"');
      }
    } else if (squadSlug !== undefined) {
      throw new ConfigError(`AGON_API_KEYS: ${role} keys cannot name a squad`);
    }
    if (seen.has(key)) throw new ConfigError('AGON_API_KEYS: duplicate key');
    seen.add(key);
    out.push({
      key,
      role: role as ApiKeyRole,
      ...(squadSlug === undefined ? {} : { squadSlug }),
    });
  }
  return out;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`PORT must be a port number, got "${value}"`);
  }
  return port;
}

function parseRole(value: string | undefined): ServerRole {
  if (value === undefined || value === '') return 'all';
  if (!(SERVER_ROLES as readonly string[]).includes(value)) {
    throw new ConfigError(`AGON_ROLE must be one of ${SERVER_ROLES.join(', ')}, got "${value}"`);
  }
  return value as ServerRole;
}

function parseLlmMode(value: string | undefined): LlmMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(LLM_MODES as readonly string[]).includes(value)) {
    throw new ConfigError(`AGON_LLM_MODE must be one of ${LLM_MODES.join(', ')}, got "${value}"`);
  }
  return value as LlmMode;
}

function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`AGON_CONCURRENCY must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Reads the server configuration from the environment. Throws `ConfigError` on bad values. */
export function readServerConfig(env: Env = process.env): ServerConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const webhookUrl = env['AGON_WEBHOOK_URL'];
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      throw new ConfigError(`AGON_WEBHOOK_URL is not a URL: "${webhookUrl}"`);
    }
  }
  return {
    databaseUrl,
    port: parsePort(env['PORT']),
    host: env['HOST'] ?? '0.0.0.0',
    role: parseRole(env['AGON_ROLE']),
    bootstrapKeys: parseBootstrapKeys(env['AGON_API_KEYS']),
    dataDir: resolve(env['AGON_DATA_DIR'] ?? DEFAULT_DATA_DIR),
    llmMode: parseLlmMode(env['AGON_LLM_MODE']),
    webhookUrl: webhookUrl || undefined,
    logLevel: env['AGON_LOG_LEVEL'] ?? 'info',
    queueSchema: env['AGON_QUEUE_SCHEMA'] ?? 'pgboss',
    concurrency: parseConcurrency(env['AGON_CONCURRENCY']),
  };
}

export function roleIncludesApi(role: ServerRole): boolean {
  return role === 'all' || role === 'api';
}

export function roleIncludesWorker(role: ServerRole): boolean {
  return role === 'all' || role === 'worker';
}
