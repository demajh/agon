import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Lowercase identifier used for user-chosen keys: variants, scenarios, metrics, personas. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const SlugSchema = z
  .string()
  .regex(SLUG_RE, 'must be a slug: lowercase letters, digits, "-" or "_" (max 63 chars)');
export type Slug = z.infer<typeof SlugSchema>;

/** Opaque, system-generated identifier (see `newId`). */
export const IdSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 timestamp with offset, e.g. 2026-10-04T17:00:00.000Z */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** A number in [0, 1]. */
export const UnitSchema = z.number().min(0).max(1);

/** `<provider>/<model>`, e.g. `anthropic/claude-sonnet-5-5` or `openai/gpt-5`. */
export const ModelRefSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    'model must be "<provider>/<model>", e.g. anthropic/claude-sonnet-5-5',
  );
export type ModelRef = z.infer<typeof ModelRefSchema>;

export function parseModelRef(ref: ModelRef): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/** Human-friendly duration: `500ms`, `30s`, `15m`, `24h`, `7d`. */
export const DurationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'duration like 30s, 15m, 24h, 7d');
export type Duration = z.infer<typeof DurationSchema>;

const DURATION_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function durationToMs(d: Duration): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(d);
  if (!m) throw new Error(`invalid duration: ${d}`);
  return Number(m[1]) * (DURATION_MS[m[2] as string] ?? 0);
}

export const ID_PREFIXES = {
  environment: 'env',
  run: 'run',
  session: 'ses',
  step: 'stp',
  event: 'evt',
  result: 'res',
  squad: 'sqd',
  decision: 'dec',
  apiKey: 'key',
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Random identifier `<prefix>_<16 base36 chars>`. Only for entities created by a human or API
 * call. Anything produced inside a run (sessions, steps, events) must derive its id from the run
 * seed instead so runs are reproducible; see `deterministicId`.
 */
export function newId(prefix: IdPrefix, length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[(bytes[i] as number) % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Deterministic child identifier, e.g. `ses_<run>_00042`. */
export function deterministicId(
  prefix: IdPrefix,
  parent: string,
  index: number,
  width = 5,
): string {
  const parentPart = parent.includes('_') ? parent.slice(parent.indexOf('_') + 1) : parent;
  return `${prefix}_${parentPart}_${String(index).padStart(width, '0')}`;
}

export function nowIso(): Timestamp {
  return new Date().toISOString();
}
