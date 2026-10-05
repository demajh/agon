import { createHash, timingSafeEqual } from 'node:crypto';
import { apiKeys, squads, type ApiKeyRole, type DbClient } from '@agon/db';
import { ForbiddenError, UnauthorizedError } from '@agon/spec';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from 'pino';
import type { BootstrapKey } from './config.js';

/** Who is calling, as resolved from the bearer token. */
export interface Principal {
  role: ApiKeyRole;
  source: 'bootstrap' | 'db';
  /** The `api_keys` row id for database keys. */
  keyId?: string;
  label: string;
  /** For squad keys: the squad the key acts for (either may be unknown if the squad was deleted). */
  squadId?: string;
  squadSlug?: string;
}

export interface AuthVariables {
  principal: Principal;
}

/** Hono environment every authenticated route runs in. */
export type AuthEnv = { Variables: AuthVariables };

export interface AuthOptions {
  db: DbClient;
  bootstrapKeys: readonly BootstrapKey[];
  logger: Logger;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The one write a squad key may perform: registering a variant (ownership is checked in the handler). */
const SQUAD_WRITE_RE = /^\/v1\/environments\/[^/]+\/variants\/?$/;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time match of the presented key against the configured ones. */
export function matchBootstrapKey(
  presented: string,
  keys: readonly BootstrapKey[],
): BootstrapKey | undefined {
  const digest = sha256(presented);
  let found: BootstrapKey | undefined;
  for (const key of keys) {
    if (timingSafeEqual(digest, sha256(key.key))) found = key;
  }
  return found;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m?.[1]?.trim();
  return token ? token : undefined;
}

/** Resolves a bearer token to a principal: bootstrap keys first, then the `api_keys` table. */
export async function resolvePrincipal(options: AuthOptions, token: string): Promise<Principal> {
  const bootstrap = matchBootstrapKey(token, options.bootstrapKeys);
  if (bootstrap) {
    const principal: Principal = {
      role: bootstrap.role,
      source: 'bootstrap',
      label: `bootstrap:${bootstrap.role}`,
    };
    if (bootstrap.squadSlug !== undefined) {
      principal.squadSlug = bootstrap.squadSlug;
      const squad = await squads.findBySlug(options.db, bootstrap.squadSlug);
      if (squad) principal.squadId = squad.id;
    }
    return principal;
  }
  const row = await apiKeys.findByKey(options.db, token);
  if (!row || !apiKeys.isActive(row)) throw new UnauthorizedError();
  apiKeys.touch(options.db, row.id).catch((error: unknown) => {
    options.logger.warn({ err: error, keyId: row.id }, 'failed to record API key use');
  });
  const principal: Principal = { role: row.role, source: 'db', keyId: row.id, label: row.label };
  if (row.squadId !== undefined) {
    principal.squadId = row.squadId;
    const squad = await squads.find(options.db, row.squadId);
    if (squad) principal.squadSlug = squad.slug;
  }
  return principal;
}

/** Whether the role may perform the request at all; finer checks live in the handlers. */
export function isAllowed(principal: Principal, method: string, path: string): boolean {
  if (READ_METHODS.has(method)) return true;
  switch (principal.role) {
    case 'operator':
      return true;
    case 'squad':
      return method === 'POST' && SQUAD_WRITE_RE.test(path);
    case 'observer':
      return false;
  }
}

/**
 * `Authorization: Bearer <key>`. Observers may only read; operators may do everything; squad keys
 * may read and register variants for their own squad.
 */
export function createAuthMiddleware(options: AuthOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) throw new UnauthorizedError();
    const principal = await resolvePrincipal(options, token);
    if (!isAllowed(principal, c.req.method, c.req.path)) {
      throw new ForbiddenError(`role "${principal.role}" may not ${c.req.method} ${c.req.path}`);
    }
    c.set('principal', principal);
    await next();
  };
}

/** Operator-only operations (API key management) call this inside the handler. */
export function assertOperator(principal: Principal): void {
  if (principal.role !== 'operator') {
    throw new ForbiddenError('this operation requires an operator key');
  }
}
