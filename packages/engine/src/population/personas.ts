import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_PERSONA_PREFIX,
  ConfigError,
  PersonaSchema,
  personaRefKind,
  type AgonConfig,
  type Persona,
  type PersonaRef,
} from '@agon/spec';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

export interface ResolvedPersona {
  persona: Persona;
  weight: number;
  source: 'builtin' | 'file' | 'inline';
}

/**
 * Where the bundled persona library may live, in priority order:
 * AGON_PERSONAS_DIR, `dist/builtin-personas` (copied at build time), the repo's `personas/`.
 */
export function builtinPersonaDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env['AGON_PERSONAS_DIR'],
    resolve(here, '../builtin-personas'),
    resolve(here, '../../../../personas'),
  ];
  return candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export function findBuiltinPersonaDir(): string | undefined {
  return builtinPersonaDirCandidates().find((d) => existsSync(d) && statSync(d).isDirectory());
}

export function loadPersonaFile(path: string): Persona {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path}: invalid persona YAML: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const parsed = PersonaSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ConfigError(
      `${path} is not a valid persona:\n${z.prettifyError(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function loadPersonaDir(dir: string): Map<string, Persona> {
  const out = new Map<string, Persona>();
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  for (const file of files) {
    const persona = loadPersonaFile(resolve(dir, file));
    if (out.has(persona.id)) {
      throw new ConfigError(`duplicate persona id "${persona.id}" in ${dir}`);
    }
    out.set(persona.id, persona);
  }
  return out;
}

export interface ResolvePersonaOptions {
  /** Base directory for relative `./persona.yaml` references. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the built-in library location. */
  builtinDir?: string;
}

/** Turns `population.personas[]` references into concrete personas with weights. */
export function resolvePersonas(
  config: AgonConfig,
  options: ResolvePersonaOptions = {},
): ResolvedPersona[] {
  const cwd = options.cwd ?? process.cwd();
  let builtin: Map<string, Persona> | undefined;
  const loadBuiltin = (): Map<string, Persona> => {
    if (builtin) return builtin;
    const dir = options.builtinDir ?? findBuiltinPersonaDir();
    if (!dir) {
      throw new ConfigError(
        'built-in persona library not found; set AGON_PERSONAS_DIR or reference persona files by path',
      );
    }
    builtin = loadPersonaDir(dir);
    return builtin;
  };
  const inline = new Map(config.personas.map((p) => [p.id, p]));

  return config.population.personas.map((ref: PersonaRef, index): ResolvedPersona => {
    const kind = personaRefKind(ref);
    if (kind === 'builtin') {
      const id = ref.use.slice(BUILTIN_PERSONA_PREFIX.length);
      const lib = loadBuiltin();
      const persona = lib.get(id);
      if (!persona) {
        throw new ConfigError(
          `population.personas[${index}]: unknown built-in persona "${id}" (available: ${[...lib.keys()].join(', ')})`,
        );
      }
      return { persona, weight: ref.weight, source: 'builtin' };
    }
    if (kind === 'file') {
      return {
        persona: loadPersonaFile(resolve(cwd, ref.use)),
        weight: ref.weight,
        source: 'file',
      };
    }
    const persona = inline.get(ref.use);
    if (!persona) {
      throw new ConfigError(
        `population.personas[${index}]: no inline persona with id "${ref.use}"`,
      );
    }
    return { persona, weight: ref.weight, source: 'inline' };
  });
}
