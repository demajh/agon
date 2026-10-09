import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { AnalysisSchema } from './analysis.js';
import { ModelRefSchema, SlugSchema } from './common.js';
import { ConfigError } from './errors.js';
import { ExportSchema } from './export.js';
import { MetricSchema } from './metric.js';
import { PersonaSchema, personaRefKind } from './persona.js';
import { PolicySchema } from './policy.js';
import { PopulationSchema } from './population.js';
import { ScenarioSchema } from './scenario.js';
import { TargetSchema } from './target.js';

export const AGON_CONFIG_VERSION = 1;
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5';
/** 12 minutes: a run that cannot finish inside a CI job's patience ends as a typed partial result. */
export const DEFAULT_TIME_CAP_MS = 720_000;

export const DefaultsSchema = z.object({
  model: ModelRefSchema.default(DEFAULT_MODEL).describe(
    'Model used when population.models is empty',
  ),
  judgeModel: ModelRefSchema.optional().describe(
    'Model for the independent judge; defaults to model',
  ),
  temperature: z.number().min(0).max(2).default(0.7),
  maxConcurrency: z
    .number()
    .int()
    .positive()
    .default(4)
    .describe('Sessions run in parallel per target'),
  timeCapMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_TIME_CAP_MS)
    .describe(
      'Wall-clock cap for the whole run in milliseconds, counted from the moment the run starts (queue time, cold start, adapter setup and session hooks all count). When reached, no new session starts, sessions in flight stop between steps, and the run ends with termination.kind = time_cap_reached: a partial result, not a failure. Default 12 minutes.',
    ),
});

/** The full `agon.yaml` document, which is also the definition of an Environment. */
export const AgonConfigSchema = z
  .object({
    version: z.literal(AGON_CONFIG_VERSION),
    name: SlugSchema,
    description: z.string().optional(),
    target: TargetSchema,
    personas: z
      .array(PersonaSchema)
      .default([])
      .describe('Inline persona definitions, referenced from population.personas[].use by id'),
    population: PopulationSchema,
    scenarios: z.array(ScenarioSchema).min(1),
    metrics: z.array(MetricSchema).default([]),
    analysis: AnalysisSchema.prefault({}),
    export: z.array(ExportSchema).default([]),
    squad: z
      .object({ id: SlugSchema })
      .optional()
      .describe('Squad credited with every variant in this config'),
    policies: z.array(PolicySchema).default([]),
    defaults: DefaultsSchema.prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const variantNames = Object.keys(cfg.target.variants);
    if (cfg.analysis.control && !variantNames.includes(cfg.analysis.control)) {
      ctx.addIssue({
        code: 'custom',
        path: ['analysis', 'control'],
        message: `control "${cfg.analysis.control}" is not one of the variants: ${variantNames.join(', ')}`,
      });
    }
    checkUnique(
      ctx,
      ['scenarios'],
      cfg.scenarios.map((s) => s.id),
      'scenario id',
    );
    checkUnique(
      ctx,
      ['metrics'],
      cfg.metrics.map((m) => m.id),
      'metric id',
    );
    checkUnique(
      ctx,
      ['personas'],
      cfg.personas.map((p) => p.id),
      'persona id',
    );
    checkUnique(
      ctx,
      ['policies'],
      cfg.policies.map((p) => p.id),
      'policy id',
    );
    const primaries = cfg.metrics.filter((m) => m.primary);
    if (primaries.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['metrics'],
        message: 'at most one metric may be primary',
      });
    }
    const inlineIds = new Set(cfg.personas.map((p) => p.id));
    cfg.population.personas.forEach((ref, i) => {
      if (personaRefKind(ref) === 'inline' && !inlineIds.has(ref.use)) {
        ctx.addIssue({
          code: 'custom',
          path: ['population', 'personas', i, 'use'],
          message: `"${ref.use}" is neither builtin/<id>, a file path, nor an inline persona id`,
        });
      }
    });
  });
export type AgonConfig = z.infer<typeof AgonConfigSchema>;
export type AgonConfigInput = z.input<typeof AgonConfigSchema>;

function checkUnique(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  ids: string[],
  what: string,
): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id))
      ctx.addIssue({
        code: 'custom',
        path: [...path, i, 'id'],
        message: `duplicate ${what} "${id}"`,
      });
    seen.add(id);
  });
}

/** The baseline variant for a config: analysis.control, else "control", else the first variant. */
export function controlVariant(cfg: AgonConfig): string {
  const names = Object.keys(cfg.target.variants);
  if (cfg.analysis.control) return cfg.analysis.control;
  if (names.includes('control')) return 'control';
  return names[0] as string;
}

const ENV_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces `${VAR}` and `${VAR:-default}` inside every string of a parsed document.
 * Missing variables without a default are an error, reported together.
 */
export function substituteEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(ENV_RE, (_m, name: string, fallback: string | undefined) => {
        const found = env[name];
        if (found !== undefined) return found;
        if (fallback !== undefined) return fallback;
        missing.add(name);
        return '';
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  const out = walk(value);
  if (missing.size) {
    throw new ConfigError(`missing environment variables: ${[...missing].sort().join(', ')}`, {
      missing: [...missing].sort(),
    });
  }
  return out;
}

export interface ParseConfigOptions {
  env?: Record<string, string | undefined>;
  /** Used in error messages. */
  source?: string;
}

/** Parses and validates an `agon.yaml` document. Throws ConfigError with a readable message. */
export function parseAgonConfig(yamlText: string, options: ParseConfigOptions = {}): AgonConfig {
  const source = options.source ?? 'agon.yaml';
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML: ${(error as Error).message}`, { cause: error });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${source}: document must be a mapping`);
  }
  const substituted = substituteEnv(doc, options.env ?? process.env);
  const parsed = AgonConfigSchema.safeParse(substituted);
  if (!parsed.success) {
    throw new ConfigError(
      `${source} is invalid:\n${z.prettifyError(parsed.error)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function readAgonConfig(path: string, options: ParseConfigOptions = {}): AgonConfig {
  return parseAgonConfig(readFileSync(path, 'utf8'), {
    ...options,
    source: options.source ?? path,
  });
}

/** JSON Schema (draft 2020-12) for `agon.yaml`, for editors and docs. */
export function agonConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgonConfigSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}
