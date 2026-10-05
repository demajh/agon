import { findBuiltinPersonaDir, loadPersonaDir } from '@agon/engine';
import { ConfigError, type Persona } from '@agon/spec';
import { createRoute } from '@hono/zod-openapi';
import type { AppContext } from '../context.js';
import { PersonaListSchema } from '../schemas.js';
import { BEARER, COMMON_ERRORS, jsonContent, type App } from './shared.js';

export const listPersonasRoute = createRoute({
  method: 'get',
  path: '/v1/personas',
  tags: ['Personas'],
  operationId: 'listPersonas',
  summary: 'List the built-in persona library',
  description: 'Reference them from a config as `builtin/<id>`.',
  security: BEARER,
  responses: {
    200: jsonContent(PersonaListSchema, 'Built-in personas, by id'),
    ...COMMON_ERRORS,
    500: COMMON_ERRORS[400],
  },
});

let cache: Persona[] | undefined;

/** The bundled library, loaded once per process. */
export function builtinPersonas(): Persona[] {
  if (cache) return cache;
  const dir = findBuiltinPersonaDir();
  if (!dir) throw new ConfigError('built-in persona library not found; set AGON_PERSONAS_DIR');
  cache = [...loadPersonaDir(dir).values()];
  return cache;
}

export function registerPersonaRoutes(app: App, _ctx: AppContext): void {
  app.openapi(listPersonasRoute, (c) => c.json({ items: builtinPersonas() }, 200));
}
