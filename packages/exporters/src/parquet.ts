import { join, resolve } from 'node:path';
import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import { parquetWriteBuffer } from 'hyparquet-writer';
import type { ColumnSource, KeyValue } from 'hyparquet-writer';
import type { Exporter, ExporterContext, ParquetExportConfig } from './exporter.js';
import { SinkError, assertAllSimulated } from './exporter.js';
import { ensureDir, writeFileAtomic } from './fs.js';
import type { EventRow, ExposureRow, MetricValueRow, SessionRow } from './rows.js';
import { eventRow, exposureRow, metricValueRows, sessionRow } from './rows.js';

export const PARQUET_FILES = {
  sessions: 'agon_sessions.parquet',
  events: 'agon_events.parquet',
  exposures: 'agon_exposures.parquet',
  metricValues: 'agon_metric_values.parquet',
} as const;

export type ParquetColumnType = 'STRING' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN';

export interface ParquetColumn<Row> {
  name: Extract<keyof Row, string>;
  type: ParquetColumnType;
  /** OPTIONAL in the parquet schema; defaults to REQUIRED. */
  nullable?: boolean;
}

export const SESSION_COLUMNS: readonly ParquetColumn<SessionRow>[] = [
  { name: 'session_id', type: 'STRING' },
  { name: 'run_id', type: 'STRING' },
  { name: 'index', type: 'INT32' },
  { name: 'variant', type: 'STRING' },
  { name: 'scenario_id', type: 'STRING' },
  { name: 'persona_id', type: 'STRING' },
  { name: 'model', type: 'STRING' },
  { name: 'device', type: 'STRING' },
  { name: 'outcome', type: 'STRING', nullable: true },
  { name: 'outcome_reason', type: 'STRING', nullable: true },
  { name: 'steps', type: 'INT32' },
  { name: 'cost_usd', type: 'DOUBLE' },
  { name: 'input_tokens', type: 'INT64' },
  { name: 'output_tokens', type: 'INT64' },
  { name: 'started_at', type: 'STRING', nullable: true },
  { name: 'finished_at', type: 'STRING', nullable: true },
  { name: 'judge_success', type: 'BOOLEAN', nullable: true },
  { name: 'judge_satisfaction', type: 'INT32', nullable: true },
  { name: 'judge_frustration', type: 'INT32', nullable: true },
  { name: 'metrics_json', type: 'STRING' },
];

export const EVENT_COLUMNS: readonly ParquetColumn<EventRow>[] = [
  { name: 'event_id', type: 'STRING' },
  { name: 'run_id', type: 'STRING' },
  { name: 'session_id', type: 'STRING' },
  { name: 'timestamp', type: 'STRING' },
  { name: 'event', type: 'STRING' },
  { name: 'distinct_id', type: 'STRING' },
  { name: 'source', type: 'STRING' },
  { name: 'provider', type: 'STRING', nullable: true },
  { name: 'variant', type: 'STRING' },
  { name: 'persona_id', type: 'STRING' },
  { name: 'model', type: 'STRING' },
  { name: 'properties_json', type: 'STRING' },
];

export const EXPOSURE_COLUMNS: readonly ParquetColumn<ExposureRow>[] = [
  { name: 'session_id', type: 'STRING' },
  { name: 'run_id', type: 'STRING' },
  { name: 'variant', type: 'STRING' },
  { name: 'experiment_key', type: 'STRING' },
  { name: 'exposed_at', type: 'STRING', nullable: true },
];

export const METRIC_VALUE_COLUMNS: readonly ParquetColumn<MetricValueRow>[] = [
  { name: 'session_id', type: 'STRING' },
  { name: 'run_id', type: 'STRING' },
  { name: 'variant', type: 'STRING' },
  { name: 'metric_id', type: 'STRING' },
  { name: 'value', type: 'DOUBLE' },
];

/** Transposes rows into hyparquet-writer's column API with explicit types (so empty tables keep their schema). */
export function toColumnData<Row extends object>(
  rows: readonly Row[],
  columns: readonly ParquetColumn<Row>[],
): ColumnSource[] {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable ?? false,
    data: rows.map((row) => encodeCell(row[column.name], column)),
  }));
}

function encodeCell<Row extends object>(value: unknown, column: ParquetColumn<Row>): unknown {
  if (value === null || value === undefined) {
    if (!column.nullable) throw new SinkError(`parquet column ${column.name} is required`);
    return null;
  }
  // hyparquet-writer encodes INT64 from bigint only.
  if (column.type === 'INT64' && typeof value === 'number') return BigInt(Math.trunc(value));
  return value;
}

/** Encodes one table to parquet bytes (SNAPPY, with statistics). */
export function parquetTable<Row extends object>(
  rows: readonly Row[],
  columns: readonly ParquetColumn<Row>[],
  kvMetadata?: KeyValue[],
): Uint8Array {
  return new Uint8Array(
    parquetWriteBuffer({ columnData: toColumnData(rows, columns), kvMetadata }),
  );
}

export interface ParquetRowCounts {
  sessions: number;
  events: number;
  exposures: number;
  metricValues: number;
  steps: number;
}

/**
 * Writes the warehouse tables to `<path>/<runId>/`: `agon_sessions.parquet`,
 * `agon_events.parquet`, `agon_exposures.parquet` and `agon_metric_values.parquet`.
 * Steps are traces, not analytics, and are not written here (use the JSONL exporter).
 *
 * Memory trade-off: rows are buffered in memory and the files are written whole on
 * `runFinished` (and again on `close` if rows arrived in between). A parquet file needs its
 * footer last and hyparquet-writer encodes from in-memory columns, so the simplest correct
 * implementation keeps the run's rows until the end: roughly 1 KB per session and 0.5-1 KB per
 * event, i.e. hundreds of MB for a 100k-session run with many events. Runs that large should
 * also configure the JSONL exporter (streaming appends); a row-group-streaming variant on
 * hyparquet-writer's `ParquetWriter` is the planned follow-up.
 */
export class ParquetExporter implements Exporter {
  readonly name = 'parquet';
  readonly dir: string;
  private readonly sessionRows: SessionRow[] = [];
  private readonly eventRows: EventRow[] = [];
  private readonly exposureRows: ExposureRow[] = [];
  private readonly metricRows: MetricValueRow[] = [];
  private stepCount = 0;
  private started = false;
  private dirty = false;
  private closed = false;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    config: ParquetExportConfig,
    private readonly ctx: ExporterContext,
  ) {
    this.dir = resolve(config.path, ctx.runId);
  }

  async runStarted(run: Run): Promise<void> {
    this.markDirty();
    await ensureDir(this.dir);
    this.ctx.logger?.info(
      { exporter: this.name, runId: run.id, dir: this.dir },
      'parquet export started',
    );
  }

  async sessionFinished(session: Session): Promise<void> {
    this.sessionRows.push(sessionRow(session));
    this.exposureRows.push(exposureRow(session, this.ctx.experimentName));
    this.metricRows.push(...metricValueRows(session));
    this.markDirty();
  }

  async steps(steps: Step[]): Promise<void> {
    this.stepCount += steps.length;
  }

  async events(events: AgonEvent[]): Promise<void> {
    assertAllSimulated(events);
    for (const event of events) this.eventRows.push(eventRow(event));
    this.markDirty();
  }

  async runFinished(_run: Run, _result?: Result): Promise<void> {
    await this.write();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.started && this.dirty) await this.write();
    else await this.writing;
  }

  rowCounts(): ParquetRowCounts {
    return {
      sessions: this.sessionRows.length,
      events: this.eventRows.length,
      exposures: this.exposureRows.length,
      metricValues: this.metricRows.length,
      steps: this.stepCount,
    };
  }

  private markDirty(): void {
    this.started = true;
    this.dirty = true;
  }

  /** Writes all four tables; concurrent calls are serialized so files are never written twice at once. */
  private write(): Promise<void> {
    const task = async (): Promise<void> => {
      this.dirty = false;
      await ensureDir(this.dir);
      const kv = this.kvMetadata();
      await Promise.all([
        this.writeTable(PARQUET_FILES.sessions, this.sessionRows, SESSION_COLUMNS, kv),
        this.writeTable(PARQUET_FILES.events, this.eventRows, EVENT_COLUMNS, kv),
        this.writeTable(PARQUET_FILES.exposures, this.exposureRows, EXPOSURE_COLUMNS, kv),
        this.writeTable(PARQUET_FILES.metricValues, this.metricRows, METRIC_VALUE_COLUMNS, kv),
      ]);
      this.ctx.logger?.info(
        { exporter: this.name, dir: this.dir, rows: this.rowCounts() },
        'parquet tables written',
      );
    };
    const next = this.writing.then(task, task);
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async writeTable<Row extends object>(
    file: string,
    rows: readonly Row[],
    columns: readonly ParquetColumn<Row>[],
    kvMetadata: KeyValue[],
  ): Promise<void> {
    await writeFileAtomic(join(this.dir, file), parquetTable(rows, columns, kvMetadata));
  }

  private kvMetadata(): KeyValue[] {
    return [
      { key: 'agon_simulated', value: 'true' },
      { key: 'agon_run_id', value: this.ctx.runId },
      { key: 'agon_experiment', value: this.ctx.experimentName },
    ];
  }
}
