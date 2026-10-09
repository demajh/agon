import { z } from 'zod';
import { TimestampSchema } from './common.js';
import { ConfigError, ValidationError } from './errors.js';

/**
 * The results contract. Every row Agon exports (sessions, steps, events, results in JSONL; the
 * warehouse tables in Parquet; the event payloads sent to PostHog and Amplitude) is stamped at
 * write time with the schema version it was written under and the id of the **required set**:
 * the list of fields a consumer may rely on at that version. A consumer never infers completeness
 * from which fields happen to be populated; it checks the stamp against the registry below.
 *
 * Ids resolve to the same field list forever. A change to a list is a new id (`agon.session.2`),
 * never an edit of `agon.session.1`; the registry `generation` grows with every published id.
 */
export const CONTRACT_SCHEMA_VERSION = '2026-10-09.1';

/** The kinds of row Agon writes, by shape. */
export const RowKindSchema = z.enum([
  // spec objects, one per line in the JSONL export
  'session',
  'step',
  'event',
  'result',
  // flat warehouse tables (Parquet): agon_sessions, agon_events, agon_exposures, agon_metric_values
  'session_row',
  'event_row',
  'exposure_row',
  'metric_value_row',
  // the property bag of an event sent to an analytics backend (PostHog, Amplitude)
  'analytics_event',
]);
export type RowKind = z.infer<typeof RowKindSchema>;

export interface RequiredSet {
  /** The schema version that published this set. */
  version: string;
  /** Dotted field paths a consumer may rely on; a nullable column is present with `null`. */
  fields: readonly string[];
}

export interface ContractRegistry {
  /** Grows with every id ever published; readers replay quarantined rows when it bumps. */
  generation: number;
  sets: Readonly<Record<string, RequiredSet>>;
}

const V1 = '2026-10-09.1';

/** Every required set ever published, by id. Lists are written out and never edited. */
export const REQUIRED_SETS: Readonly<Record<string, RequiredSet>> = {
  'agon.session.1': {
    version: V1,
    fields: [
      'id',
      'runId',
      'index',
      'variant',
      'scenarioId',
      'persona',
      'persona.personaId',
      'persona.model',
      'persona.distinctId',
      'status',
      'steps',
      'costUsd',
      'inputTokens',
      'outputTokens',
      'metrics',
    ],
  },
  'agon.step.1': {
    version: V1,
    fields: [
      'id',
      'sessionId',
      'index',
      'observation',
      'decision',
      'result',
      'patience',
      'usage',
      'startedAt',
      'durationMs',
    ],
  },
  'agon.event.1': {
    version: V1,
    fields: [
      'id',
      'runId',
      'sessionId',
      'timestamp',
      'event',
      'distinctId',
      'source',
      'properties',
      'properties.agon_simulated',
      'properties.agon_run_id',
      'properties.agon_session_id',
      'properties.agon_variant',
      'properties.agon_persona',
      'properties.agon_model',
    ],
  },
  'agon.result.1': {
    version: V1,
    fields: [
      'id',
      'runId',
      'method',
      'control',
      'primaryMetricId',
      'metrics',
      'decision',
      'decision.verdict',
      'decision.rationale',
      'calibration',
      'calibration.profile',
      'calibration.note',
      'sessionsAnalyzed',
      'computedAt',
      'engine',
      'kind',
      'assumptions',
      'requirementsDigest',
    ],
  },
  'agon.session_row.1': {
    version: V1,
    fields: [
      'session_id',
      'run_id',
      'index',
      'variant',
      'scenario_id',
      'persona_id',
      'model',
      'device',
      'outcome',
      'outcome_reason',
      'steps',
      'cost_usd',
      'input_tokens',
      'output_tokens',
      'started_at',
      'finished_at',
      'judge_success',
      'judge_satisfaction',
      'judge_frustration',
      'metrics_json',
    ],
  },
  'agon.event_row.1': {
    version: V1,
    fields: [
      'event_id',
      'run_id',
      'session_id',
      'timestamp',
      'event',
      'distinct_id',
      'source',
      'provider',
      'variant',
      'persona_id',
      'model',
      'properties_json',
    ],
  },
  'agon.exposure_row.1': {
    version: V1,
    fields: ['session_id', 'run_id', 'variant', 'experiment_key', 'exposed_at'],
  },
  'agon.metric_value_row.1': {
    version: V1,
    fields: ['session_id', 'run_id', 'variant', 'metric_id', 'value'],
  },
  'agon.analytics_event.1': {
    version: V1,
    fields: [
      'agon_simulated',
      'agon_run_id',
      'agon_session_id',
      'agon_variant',
      'agon_persona',
      'agon_model',
    ],
  },
};

/** The registry this build of Agon writes and reads with. */
export const CONTRACT_REGISTRY: ContractRegistry = { generation: 1, sets: REQUIRED_SETS };

/** The id each row kind is stamped with by this build. */
export const CURRENT_REQUIRED_SET: Readonly<Record<RowKind, string>> = {
  session: 'agon.session.1',
  step: 'agon.step.1',
  event: 'agon.event.1',
  result: 'agon.result.1',
  session_row: 'agon.session_row.1',
  event_row: 'agon.event_row.1',
  exposure_row: 'agon.exposure_row.1',
  metric_value_row: 'agon.metric_value_row.1',
  analytics_event: 'agon.analytics_event.1',
};

// --- the stamp ------------------------------------------------------------------------------------

/** The two fields every exported row carries (camelCase on spec objects). */
export const ContractStampSchema = z.object({
  schemaVersion: z.string().min(1),
  requiredSet: z.string().min(1),
});
export type ContractStamp = z.infer<typeof ContractStampSchema>;

/** The same stamp as the warehouse tables spell it. */
export interface WarehouseStamp {
  schema_version: string;
  required_set: string;
}

/** The same stamp as analytics properties, prefixed like the other simulation markers. */
export interface AnalyticsStamp {
  agon_schema_version: string;
  agon_required_set: string;
}

/** Placeholder id recorded for a row that carries no stamp at all; it can never resolve. */
export const UNSTAMPED_REQUIRED_SET = '(unstamped)';

function valueAt(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Fields of the set the row does not carry (`undefined` or a missing key; `null` counts as present). */
export function missingFields(row: unknown, fields: readonly string[]): string[] {
  return fields.filter((field) => valueAt(row, field) === undefined);
}

/** Throws `ValidationError` unless the row carries every field of the set it is about to be stamped with. */
export function assertRequiredFields(kind: RowKind, row: unknown): string {
  const id = CURRENT_REQUIRED_SET[kind];
  const set = REQUIRED_SETS[id];
  if (set === undefined) throw new ConfigError(`required set ${id} is not in the registry`);
  const missing = missingFields(row, set.fields);
  if (missing.length > 0) {
    throw new ValidationError(`cannot stamp ${kind} with ${id}: missing ${missing.join(', ')}`, {
      kind,
      requiredSet: id,
      missing,
    });
  }
  return id;
}

/** Stamps a spec object (`schemaVersion`, `requiredSet`), verifying the set's fields are present. */
export function stampRow<T extends object>(kind: RowKind, row: T): T & ContractStamp {
  const requiredSet = assertRequiredFields(kind, row);
  return { ...row, schemaVersion: CONTRACT_SCHEMA_VERSION, requiredSet };
}

/** Stamps a warehouse row (`schema_version`, `required_set`). */
export function stampWarehouseRow<T extends object>(kind: RowKind, row: T): T & WarehouseStamp {
  const required_set = assertRequiredFields(kind, row);
  return { ...row, schema_version: CONTRACT_SCHEMA_VERSION, required_set };
}

/** The stamp as analytics properties (`agon_schema_version`, `agon_required_set`). */
export function analyticsStamp(properties: object): AnalyticsStamp {
  const agon_required_set = assertRequiredFields('analytics_event', properties);
  return { agon_schema_version: CONTRACT_SCHEMA_VERSION, agon_required_set };
}

/** Reads the stamp in any of its three spellings; `undefined` when the row carries none. */
export function readStamp(row: unknown): ContractStamp | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const candidates: [unknown, unknown][] = [
    [r['schemaVersion'], r['requiredSet']],
    [r['schema_version'], r['required_set']],
    [r['agon_schema_version'], r['agon_required_set']],
  ];
  const properties = r['properties'];
  if (properties !== null && typeof properties === 'object') {
    const p = properties as Record<string, unknown>;
    candidates.push([p['agon_schema_version'], p['agon_required_set']]);
  }
  for (const [version, set] of candidates) {
    if (typeof version === 'string' && typeof set === 'string' && version && set) {
      return { schemaVersion: version, requiredSet: set };
    }
  }
  return undefined;
}

// --- the reader gate (pure core) -----------------------------------------------------------------

/**
 * Why a reader refuses a row. `REQUIRED_SET_UNRESOLVED`: the row's id is not in the reader's
 * registry (quarantine, replay when the registry bumps). `REQUIRED_SET_NOT_SUPERSET`: the row's
 * set does not cover the reader's (hard reject). `QUARANTINE_EXPIRED`: the quarantine TTL ran out
 * before the registry caught up (hard reject, counted in the lag ledger).
 */
export const GateRejectionCodeSchema = z.enum([
  'REQUIRED_SET_UNRESOLVED',
  'REQUIRED_SET_NOT_SUPERSET',
  'QUARANTINE_EXPIRED',
]);
export type GateRejectionCode = z.infer<typeof GateRejectionCodeSchema>;

export type GateCheck =
  | { ok: true; requiredSet: string; version: string }
  | { ok: false; code: 'REQUIRED_SET_UNRESOLVED'; requiredSet: string }
  | { ok: false; code: 'REQUIRED_SET_NOT_SUPERSET'; requiredSet: string; missing: string[] };

/** Whether every field the reader relies on is in the row's set. */
export function isSuperset(rowSet: RequiredSet, readerSet: RequiredSet): boolean {
  const have = new Set(rowSet.fields);
  return readerSet.fields.every((field) => have.has(field));
}

/** Resolves a reader's declared set; a reader naming an unknown id is a programming error. */
export function readerSet(id: string, registry: ContractRegistry): RequiredSet {
  const set = registry.sets[id];
  if (set === undefined)
    throw new ConfigError(`reader required set ${id} is not in the registry`, { requiredSet: id });
  return set;
}

/**
 * The superset rule: a row is accepted only if its stamped set is in the registry and covers the
 * reader's set. An id alone is not enough because two ids can share a prefix and differ in one
 * field; the registry holds the field lists so the comparison is on fields, never on names.
 */
export function checkRow(row: unknown, reader: string, registry: ContractRegistry): GateCheck {
  const wanted = readerSet(reader, registry);
  const stamp = readStamp(row);
  if (stamp === undefined) {
    return { ok: false, code: 'REQUIRED_SET_UNRESOLVED', requiredSet: UNSTAMPED_REQUIRED_SET };
  }
  const have = registry.sets[stamp.requiredSet];
  if (have === undefined) {
    return { ok: false, code: 'REQUIRED_SET_UNRESOLVED', requiredSet: stamp.requiredSet };
  }
  if (!isSuperset(have, wanted)) {
    const covered = new Set(have.fields);
    return {
      ok: false,
      code: 'REQUIRED_SET_NOT_SUPERSET',
      requiredSet: stamp.requiredSet,
      missing: wanted.fields.filter((f) => !covered.has(f)),
    };
  }
  return { ok: true, requiredSet: stamp.requiredSet, version: have.version };
}

// --- quarantine and lag ledger (persisted shapes) ------------------------------------------------

export const QuarantineEntrySchema = z.object({
  key: z.string().min(1),
  requiredSet: z.string().min(1),
  row: z.unknown(),
  generation: z.number().int().nonnegative().describe('Registry generation at ingest'),
  ingestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>;

/**
 * One entry per (registry generation, unresolved id) whose quarantine expired. Closed with
 * `reconciledAt` when a later generation resolves the id; never deleted, so the time-to-reconcile
 * denominator survives the replay.
 */
export const LagLedgerEntrySchema = z.object({
  requiredSet: z.string().min(1),
  generation: z.number().int().nonnegative().describe('Registry generation when the rows expired'),
  rows: z.number().int().positive().describe('Rows that expired under this id at this generation'),
  firstSeenAt: TimestampSchema,
  expiredAt: TimestampSchema,
  reconciledAt: TimestampSchema.optional(),
  reconciledGeneration: z.number().int().nonnegative().optional(),
});
export type LagLedgerEntry = z.infer<typeof LagLedgerEntrySchema>;

/** A row whose quarantine expired: refused with `QUARANTINE_EXPIRED`, never replayed. */
export const ExpiredRowSchema = z.object({
  key: z.string().min(1),
  requiredSet: z.string().min(1),
  generation: z.number().int().nonnegative(),
  expiredAt: TimestampSchema,
});
export type ExpiredRow = z.infer<typeof ExpiredRowSchema>;

/** A row hard-rejected with `REQUIRED_SET_NOT_SUPERSET`, with the reader's fields it lacks. */
export const RejectedRowSchema = z.object({
  key: z.string().min(1),
  requiredSet: z.string().min(1),
  missing: z.array(z.string()),
});
export type RejectedRow = z.infer<typeof RejectedRowSchema>;

/** The persisted state of one reader gate (`saveGateSnapshot`), for counting and restarts. */
export const GateSnapshotSchema = z.object({
  version: z.literal(1),
  readerSet: z.string().min(1),
  generation: z.number().int().nonnegative(),
  quarantineTtlMs: z.number().positive(),
  accepted: z.array(
    z.object({ key: z.string().min(1), row: z.unknown(), requiredSet: z.string().min(1) }),
  ),
  quarantine: z.array(QuarantineEntrySchema),
  rejected: z.array(RejectedRowSchema),
  expired: z.array(ExpiredRowSchema),
  lagLedger: z.array(LagLedgerEntrySchema),
});
export type GateSnapshot = z.infer<typeof GateSnapshotSchema>;

/** Milliseconds between expiry and reconciliation; `undefined` while the entry is open. */
export function timeToReconcileMs(entry: LagLedgerEntry): number | undefined {
  if (entry.reconciledAt === undefined) return undefined;
  return Date.parse(entry.reconciledAt) - Date.parse(entry.expiredAt);
}
