import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GateSnapshotSchema,
  ValidationError,
  checkRow,
  readerSet,
  type ContractRegistry,
  type ExpiredRow,
  type GateRejectionCode,
  type GateSnapshot,
  type LagLedgerEntry,
  type QuarantineEntry,
  type RejectedRow,
} from '@agon/spec';
import { z } from 'zod';
import { ensureDir, writeFileAtomic } from './fs.js';

/**
 * The reader gate of the results contract (docs/results-contract.md). A reader declares the
 * required set it was written against; a row is served only if its stamped set is in the
 * registry and is a superset of the reader's.
 *
 * - `REQUIRED_SET_UNRESOLVED`: the row's id is not in the registry. The row is quarantined with
 *   a bounded TTL, never served, and replayed when the registry generation bumps.
 * - `REQUIRED_SET_NOT_SUPERSET`: hard reject, on ingest and on serve.
 * - `QUARANTINE_EXPIRED`: the TTL ran out before the registry caught up. Hard reject on serve
 *   with its own code; the unresolved id is mirrored into the lag ledger, keyed by registry
 *   generation, so time-to-reconcile can be counted. Ledger entries are closed with
 *   `reconciledAt` when a replay resolves the id and are never deleted.
 *
 * Persistence (`snapshot`/`restore`, `saveGateSnapshot`/`loadGateSnapshot`) exists for counting,
 * not promotion: nothing in the quarantine or the ledger is ever served from there.
 */
export interface RowGateOptions<Row> {
  registry: ContractRegistry;
  /** The required-set id this reader relies on; must be in the registry. */
  readerSet: string;
  quarantineTtlMs: number;
  /** Identifies a row; default `row.id`. */
  keyOf?: ((row: Row) => string) | undefined;
  /** The clock; tests inject one. */
  now?: (() => Date) | undefined;
}

export type IngestOutcome<Row> =
  | { status: 'accepted'; key: string; row: Row; requiredSet: string }
  | {
      status: 'quarantined';
      key: string;
      code: 'REQUIRED_SET_UNRESOLVED';
      requiredSet: string;
      expiresAt: string;
    }
  | {
      status: 'rejected';
      key: string;
      code: 'REQUIRED_SET_NOT_SUPERSET';
      requiredSet: string;
      missing: string[];
    };

export type ServeOutcome<Row> =
  | { ok: true; key: string; row: Row }
  | { ok: false; key: string; code: GateRejectionCode; requiredSet: string };

export interface ReplayOutcome<Row> {
  generation: number;
  /** Rows the new registry resolves and accepts; hand them to the normal pipeline. */
  accepted: { key: string; row: Row; requiredSet: string }[];
  rejected: { key: string; requiredSet: string; missing: string[] }[];
  stillQuarantined: number;
  /** Lag-ledger entries this bump closed. */
  reconciled: LagLedgerEntry[];
}

function defaultKey(row: unknown): string {
  const id = row !== null && typeof row === 'object' ? (row as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || id.length === 0)
    throw new ValidationError('row has no string `id`; pass keyOf to the gate');
  return id;
}

function ledgerKey(generation: number, requiredSet: string): string {
  return `${generation}\u0000${requiredSet}`;
}

export class RowGate<Row = unknown> {
  private registry: ContractRegistry;
  private generationValue: number;
  private readonly accepted = new Map<string, { row: Row; requiredSet: string }>();
  private readonly quarantine = new Map<string, QuarantineEntry>();
  private readonly rejected = new Map<string, RejectedRow>();
  private readonly expired = new Map<string, ExpiredRow>();
  private readonly ledger = new Map<string, LagLedgerEntry>();
  private readonly keyOf: (row: Row) => string;
  private readonly clock: () => Date;

  constructor(private readonly options: RowGateOptions<Row>) {
    readerSet(options.readerSet, options.registry); // throws ConfigError for an unknown reader set
    if (!(options.quarantineTtlMs > 0))
      throw new ValidationError('quarantineTtlMs must be positive');
    this.registry = options.registry;
    this.generationValue = options.registry.generation;
    this.keyOf = options.keyOf ?? ((row) => defaultKey(row));
    this.clock = options.now ?? (() => new Date());
  }

  get generation(): number {
    return this.generationValue;
  }

  get readerSet(): string {
    return this.options.readerSet;
  }

  /** Checks one row against the registry: accepted, quarantined or rejected. */
  ingest(row: Row): IngestOutcome<Row> {
    this.sweep();
    const key = this.keyOf(row);
    // A key seen before is re-evaluated: re-ingesting an expired or rejected row is the only
    // way back in, and it goes through the same check as any other row.
    this.quarantine.delete(key);
    this.rejected.delete(key);
    this.expired.delete(key);
    this.accepted.delete(key);
    const check = checkRow(row, this.options.readerSet, this.registry);
    if (check.ok) {
      this.accepted.set(key, { row, requiredSet: check.requiredSet });
      return { status: 'accepted', key, row, requiredSet: check.requiredSet };
    }
    if (check.code === 'REQUIRED_SET_UNRESOLVED') {
      const now = this.clock();
      const entry: QuarantineEntry = {
        key,
        requiredSet: check.requiredSet,
        row,
        generation: this.generationValue,
        ingestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.options.quarantineTtlMs).toISOString(),
      };
      this.quarantine.set(key, entry);
      return {
        status: 'quarantined',
        key,
        code: check.code,
        requiredSet: check.requiredSet,
        expiresAt: entry.expiresAt,
      };
    }
    this.rejected.set(key, { key, requiredSet: check.requiredSet, missing: check.missing });
    return {
      status: 'rejected',
      key,
      code: check.code,
      requiredSet: check.requiredSet,
      missing: check.missing,
    };
  }

  /** Serves an accepted row; everything else is refused with its code. `undefined`: never seen. */
  serve(key: string): ServeOutcome<Row> | undefined {
    this.sweep();
    const accepted = this.accepted.get(key);
    if (accepted !== undefined) return { ok: true, key, row: accepted.row };
    const quarantined = this.quarantine.get(key);
    if (quarantined !== undefined) {
      return {
        ok: false,
        key,
        code: 'REQUIRED_SET_UNRESOLVED',
        requiredSet: quarantined.requiredSet,
      };
    }
    const expired = this.expired.get(key);
    if (expired !== undefined)
      return { ok: false, key, code: 'QUARANTINE_EXPIRED', requiredSet: expired.requiredSet };
    const rejected = this.rejected.get(key);
    if (rejected !== undefined)
      return {
        ok: false,
        key,
        code: 'REQUIRED_SET_NOT_SUPERSET',
        requiredSet: rejected.requiredSet,
      };
    return undefined;
  }

  /**
   * Moves quarantined rows whose TTL ran out to the expired set and mirrors each unresolved id
   * into the lag ledger under the current registry generation. Called lazily by every operation.
   */
  sweep(): ExpiredRow[] {
    const now = this.clock();
    const nowIso = now.toISOString();
    const out: ExpiredRow[] = [];
    for (const [key, entry] of [...this.quarantine.entries()]) {
      if (Date.parse(entry.expiresAt) > now.getTime()) continue;
      this.quarantine.delete(key);
      const record: ExpiredRow = {
        key,
        requiredSet: entry.requiredSet,
        generation: this.generationValue,
        expiredAt: nowIso,
      };
      this.expired.set(key, record);
      out.push(record);
      const id = ledgerKey(this.generationValue, entry.requiredSet);
      const existing = this.ledger.get(id);
      if (existing === undefined) {
        this.ledger.set(id, {
          requiredSet: entry.requiredSet,
          generation: this.generationValue,
          rows: 1,
          firstSeenAt: entry.ingestedAt,
          expiredAt: nowIso,
        });
      } else {
        existing.rows += 1;
        if (entry.ingestedAt < existing.firstSeenAt) existing.firstSeenAt = entry.ingestedAt;
      }
    }
    return out;
  }

  /**
   * Replays the quarantine against a newer registry generation. Rows the new registry resolves
   * are accepted (returned for the caller's normal pipeline) or hard-rejected; open lag-ledger
   * entries whose id now resolves are closed with `reconciledAt`.
   */
  bump(registry: ContractRegistry): ReplayOutcome<Row> {
    if (registry.generation <= this.generationValue) {
      throw new ValidationError(
        `registry generation ${registry.generation} is not newer than ${this.generationValue}`,
      );
    }
    this.sweep();
    readerSet(this.options.readerSet, registry);
    this.registry = registry;
    this.generationValue = registry.generation;
    const outcome: ReplayOutcome<Row> = {
      generation: registry.generation,
      accepted: [],
      rejected: [],
      stillQuarantined: 0,
      reconciled: [],
    };
    for (const [key, entry] of [...this.quarantine.entries()]) {
      if (registry.sets[entry.requiredSet] === undefined) {
        outcome.stillQuarantined += 1;
        continue;
      }
      this.quarantine.delete(key);
      const row = entry.row as Row;
      const check = checkRow(row, this.options.readerSet, registry);
      if (check.ok) {
        this.accepted.set(key, { row, requiredSet: check.requiredSet });
        outcome.accepted.push({ key, row, requiredSet: check.requiredSet });
      } else if (check.code === 'REQUIRED_SET_NOT_SUPERSET') {
        this.rejected.set(key, { key, requiredSet: check.requiredSet, missing: check.missing });
        outcome.rejected.push({ key, requiredSet: check.requiredSet, missing: check.missing });
      } else {
        this.quarantine.set(key, entry);
        outcome.stillQuarantined += 1;
      }
    }
    const nowIso = this.clock().toISOString();
    for (const entry of this.ledger.values()) {
      if (entry.reconciledAt !== undefined) continue;
      if (registry.sets[entry.requiredSet] === undefined) continue;
      entry.reconciledAt = nowIso;
      entry.reconciledGeneration = registry.generation;
      outcome.reconciled.push({ ...entry });
    }
    return outcome;
  }

  /** The lag ledger: one entry per (generation, unresolved id) that expired; closed ones included. */
  lagLedger(): LagLedgerEntry[] {
    return [...this.ledger.values()].map((e) => ({ ...e }));
  }

  quarantined(): QuarantineEntry[] {
    this.sweep();
    return [...this.quarantine.values()];
  }

  acceptedKeys(): string[] {
    return [...this.accepted.keys()];
  }

  snapshot(): GateSnapshot {
    this.sweep();
    return {
      version: 1,
      readerSet: this.options.readerSet,
      generation: this.generationValue,
      quarantineTtlMs: this.options.quarantineTtlMs,
      accepted: [...this.accepted.entries()].map(([key, a]) => ({ key, ...a })),
      quarantine: [...this.quarantine.values()],
      rejected: [...this.rejected.values()],
      expired: [...this.expired.values()],
      lagLedger: this.lagLedger(),
    };
  }

  /** Rebuilds a gate from a snapshot. The registry passed must be at least the snapshot's generation. */
  static restore<Row>(
    snapshot: GateSnapshot,
    options: Omit<RowGateOptions<Row>, 'readerSet' | 'quarantineTtlMs'> &
      Partial<Pick<RowGateOptions<Row>, 'readerSet' | 'quarantineTtlMs'>>,
  ): RowGate<Row> {
    if (options.registry.generation < snapshot.generation) {
      throw new ValidationError(
        `registry generation ${options.registry.generation} is older than the snapshot's ${snapshot.generation}`,
      );
    }
    const gate = new RowGate<Row>({
      ...options,
      readerSet: options.readerSet ?? snapshot.readerSet,
      quarantineTtlMs: options.quarantineTtlMs ?? snapshot.quarantineTtlMs,
    });
    gate.generationValue = snapshot.generation;
    for (const a of snapshot.accepted)
      gate.accepted.set(a.key, { row: a.row as Row, requiredSet: a.requiredSet });
    for (const q of snapshot.quarantine) gate.quarantine.set(q.key, q);
    for (const r of snapshot.rejected) gate.rejected.set(r.key, r);
    for (const e of snapshot.expired) gate.expired.set(e.key, e);
    for (const l of snapshot.lagLedger)
      gate.ledger.set(ledgerKey(l.generation, l.requiredSet), { ...l });
    if (options.registry.generation > snapshot.generation) gate.bump(options.registry);
    return gate;
  }
}

/** Writes a gate's state as JSON (counting only; nothing in it is served from the file). */
export async function saveGateSnapshot<Row>(path: string, gate: RowGate<Row>): Promise<void> {
  await ensureDir(dirname(path));
  await writeFileAtomic(path, `${JSON.stringify(gate.snapshot(), null, 2)}\n`);
}

export async function loadGateSnapshot(path: string): Promise<GateSnapshot | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`gate snapshot ${path} is not JSON: ${String(error)}`);
  }
  const parsed = GateSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      `gate snapshot ${path} is invalid:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
