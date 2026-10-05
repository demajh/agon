import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { AgonConfigSchema, ValidationError, parseAgonConfig, type AgonConfig } from '@agon/spec';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import { zodIssues } from '../errors.js';
import { validatePolicies } from '../policies.js';
import { ErrorResponseSchema, type ValidateConfigResponse } from '../schemas.js';

export type App = OpenAPIHono<AuthEnv>;

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } } as const;
}

const error = (description: string) => jsonContent(ErrorResponseSchema, description);

/** The error responses every authenticated route can produce. */
export const COMMON_ERRORS = {
  400: error('Invalid request or config (`validation_error`, `config_error`)'),
  401: error('Missing or invalid API key (`unauthorized`)'),
  403: error('The key role may not perform this operation (`forbidden`)'),
} as const;

export const NOT_FOUND = { 404: error('No such resource (`not_found`)') } as const;
export const CONFLICT = {
  409: error('The operation conflicts with the current state (`conflict`)'),
} as const;

export const BEARER = [{ bearerAuth: [] }];

const YAML_TYPES = ['application/yaml', 'text/yaml', 'application/x-yaml', 'text/x-yaml'];

export function isYamlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return YAML_TYPES.includes(essence);
}

const PLACEHOLDER = '${';

/** Finds the first `${...}` left in any string of a document (path for the error message). */
export function findPlaceholder(value: unknown, path = ''): string | undefined {
  if (typeof value === 'string')
    return value.includes(PLACEHOLDER) ? path || '<document>' : undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPlaceholder(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const found = findPlaceholder(v, path ? `${path}.${k}` : k);
      if (found) return found;
    }
  }
  return undefined;
}

export const PLACEHOLDER_MESSAGE =
  'config still contains ${...} placeholders; the server never expands environment variables. Resolve them client-side (the agon CLI does) before uploading';

export function assertNoPlaceholders(value: unknown): void {
  const at = findPlaceholder(value);
  if (at !== undefined) throw new ValidationError(PLACEHOLDER_MESSAGE, { path: at });
}

export interface ConfigBody {
  name?: string | undefined;
  config: AgonConfig;
}

/**
 * Reads a config from the request: a YAML document (`application/yaml`) or the already validated
 * JSON body `{ name?, config }`. Placeholders are rejected either way.
 */
export async function readConfigBody(
  c: Context<AuthEnv>,
  json: { name?: string | undefined; config?: AgonConfig | undefined } | undefined,
): Promise<ConfigBody> {
  if (isYamlContentType(c.req.header('content-type'))) {
    const text = await c.req.text();
    if (text.includes(PLACEHOLDER)) throw new ValidationError(PLACEHOLDER_MESSAGE);
    const config = parseAgonConfig(text, { env: {}, source: 'request body' });
    validatePolicies(config.policies);
    return { config };
  }
  if (!json || json.config === undefined) {
    throw new ValidationError(
      'request body must be {"config": <agon.yaml as JSON>} or a YAML document',
    );
  }
  assertNoPlaceholders(json.config);
  validatePolicies(json.config.policies);
  return { name: json.name, config: json.config };
}

/** Validates a candidate config without storing it; never throws for config problems. */
export async function validateConfigBody(
  c: Context<AuthEnv>,
  json: { config?: unknown } | undefined,
): Promise<ValidateConfigResponse> {
  let candidate: unknown;
  if (isYamlContentType(c.req.header('content-type'))) {
    const text = await c.req.text();
    if (text.includes(PLACEHOLDER))
      return { ok: false, issues: [{ path: '', message: PLACEHOLDER_MESSAGE }] };
    try {
      candidate = parseAgonConfig(text, { env: {}, source: 'request body' });
    } catch (error) {
      return {
        ok: false,
        issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      };
    }
  } else {
    if (!json || !('config' in json)) {
      return { ok: false, issues: [{ path: 'config', message: 'missing config' }] };
    }
    candidate = json.config;
  }
  const placeholder = findPlaceholder(candidate);
  if (placeholder !== undefined) {
    return { ok: false, issues: [{ path: placeholder, message: PLACEHOLDER_MESSAGE }] };
  }
  const parsed = AgonConfigSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  try {
    validatePolicies(parsed.data.policies);
  } catch (error) {
    return {
      ok: false,
      issues: [
        { path: 'policies', message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
  return { ok: true, issues: [] };
}

/** `limit`/`cursor` query values as the repositories take them. */
export function pageOptions(query: { limit?: number | undefined; cursor?: string | undefined }) {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}
