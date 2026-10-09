import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONTRACT_SCHEMA_VERSION,
  CURRENT_REQUIRED_SET,
  SCENARIO_SUCCESS_METRIC_ID,
  ValidationError,
} from '@agon/spec';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPERIMENT_NAME,
  RUN_ID,
  isSuccessful,
  makeContext,
  makeRun,
  makeSession,
  makeTempDir,
  makeUnmarkedEvent,
  removeDir,
  runLifecycle,
} from './__fixtures__/fixtures.js';
import {
  EVENT_COLUMNS,
  EXPOSURE_COLUMNS,
  METRIC_VALUE_COLUMNS,
  PARQUET_FILES,
  ParquetExporter,
  SESSION_COLUMNS,
} from './parquet.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await removeDir(dir);
});

interface Table {
  columns: string[];
  rows: Record<string, unknown>[];
  numRows: number;
  kv: Record<string, string | undefined>;
}

async function readTable(path: string): Promise<Table> {
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const rows = (await parquetReadObjects({ file, metadata, rowFormat: 'object' })) as Record<
    string,
    unknown
  >[];
  return {
    columns: metadata.schema.slice(1).map((element) => element.name),
    rows,
    numRows: Number(metadata.num_rows),
    kv: Object.fromEntries((metadata.key_value_metadata ?? []).map((kv) => [kv.key, kv.value])),
  };
}

describe('ParquetExporter', () => {
  it('writes the four tables with the expected columns and row counts', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    const data = await runLifecycle(exporter, {
      sessions: 4,
      stepsPerSession: 1,
      eventsPerSession: 3,
    });
    await exporter.close();

    const runDir = join(dir, RUN_ID);
    expect((await readdir(runDir)).sort()).toEqual(Object.values(PARQUET_FILES).sort());

    const sessions = await readTable(join(runDir, PARQUET_FILES.sessions));
    expect(sessions.columns).toEqual(SESSION_COLUMNS.map((c) => c.name));
    expect(sessions.numRows).toBe(4);
    expect(sessions.kv).toMatchObject({
      agon_simulated: 'true',
      agon_run_id: RUN_ID,
      agon_experiment: EXPERIMENT_NAME,
    });

    const events = await readTable(join(runDir, PARQUET_FILES.events));
    expect(events.columns).toEqual(EVENT_COLUMNS.map((c) => c.name));
    expect(events.numRows).toBe(12);

    const exposures = await readTable(join(runDir, PARQUET_FILES.exposures));
    expect(exposures.columns).toEqual(EXPOSURE_COLUMNS.map((c) => c.name));
    expect(exposures.numRows).toBe(4);

    const metricValues = await readTable(join(runDir, PARQUET_FILES.metricValues));
    expect(metricValues.columns).toEqual(METRIC_VALUE_COLUMNS.map((c) => c.name));
    // two configured metrics per session plus scenario_success
    expect(metricValues.numRows).toBe(4 * 3);
    expect(exporter.rowCounts()).toEqual({
      sessions: 4,
      events: 12,
      exposures: 4,
      metricValues: 12,
      steps: 4,
    });
    expect(data.sessions).toHaveLength(4);
  });

  it('round-trips session values, including nulls, bigints and the metrics JSON', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    const data = await runLifecycle(exporter, { sessions: 3, eventsPerSession: 1 });
    await exporter.close();

    const { rows } = await readTable(join(dir, RUN_ID, PARQUET_FILES.sessions));
    const byId = new Map(rows.map((row) => [row.session_id, row]));
    for (const session of data.sessions) {
      const row = byId.get(session.id);
      expect(row).toBeDefined();
      if (!row) continue;
      expect(row.run_id).toBe(RUN_ID);
      expect(row.index).toBe(session.index);
      expect(row.variant).toBe(session.variant);
      expect(row.scenario_id).toBe(session.scenarioId);
      expect(row.persona_id).toBe(session.persona.personaId);
      expect(row.model).toBe(session.persona.model);
      expect(row.device).toBe(session.persona.device);
      expect(row.outcome).toBe(session.outcome);
      expect(row.outcome_reason ?? null).toBe(session.outcomeReason ?? null);
      expect(row.steps).toBe(session.steps);
      expect(row.cost_usd).toBeCloseTo(session.costUsd);
      expect(Number(row.input_tokens)).toBe(session.inputTokens);
      expect(Number(row.output_tokens)).toBe(session.outputTokens);
      expect(row.started_at).toBe(session.startedAt);
      expect(row.finished_at).toBe(session.finishedAt);
      expect(row.judge_success ?? null).toBe(session.judgement?.success ?? null);
      expect(row.judge_satisfaction ?? null).toBe(session.judgement?.satisfaction ?? null);
      expect(row.judge_frustration ?? null).toBe(session.judgement?.frustration ?? null);
      expect(JSON.parse(String(row.metrics_json))).toEqual(session.metrics);
    }
  });

  it('writes events with markers in dedicated columns and the full properties as JSON', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    const data = await runLifecycle(exporter, { sessions: 2, eventsPerSession: 2 });
    await exporter.close();

    const { rows } = await readTable(join(dir, RUN_ID, PARQUET_FILES.events));
    const byId = new Map(rows.map((row) => [row.event_id, row]));
    for (const event of data.events) {
      const row = byId.get(event.id);
      expect(row).toBeDefined();
      if (!row) continue;
      expect(row.session_id).toBe(event.sessionId);
      expect(row.timestamp).toBe(event.timestamp);
      expect(row.event).toBe(event.event);
      expect(row.distinct_id).toBe(event.distinctId);
      expect(row.source).toBe(event.source);
      expect(row.provider ?? null).toBe(event.provider ?? null);
      expect(row.variant).toBe(event.properties.agon_variant);
      expect(row.persona_id).toBe(event.properties.agon_persona);
      expect(row.model).toBe(event.properties.agon_model);
      const properties = JSON.parse(String(row.properties_json)) as Record<string, unknown>;
      expect(properties).toEqual(event.properties);
      expect(properties.agon_simulated).toBe(true);
    }
  });

  it('writes exposures keyed by the experiment name and metric values with scenario_success', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    const data = await runLifecycle(exporter, { sessions: 4, eventsPerSession: 1 });
    await exporter.close();

    const exposures = await readTable(join(dir, RUN_ID, PARQUET_FILES.exposures));
    for (const session of data.sessions) {
      const row = exposures.rows.find((r) => r.session_id === session.id);
      expect(row).toMatchObject({
        run_id: RUN_ID,
        variant: session.variant,
        experiment_key: EXPERIMENT_NAME,
        exposed_at: session.startedAt,
      });
    }

    const metricValues = await readTable(join(dir, RUN_ID, PARQUET_FILES.metricValues));
    for (const session of data.sessions) {
      const rows = metricValues.rows.filter((r) => r.session_id === session.id);
      const values = Object.fromEntries(rows.map((r) => [r.metric_id, r.value]));
      expect(values).toEqual({
        ...session.metrics,
        [SCENARIO_SUCCESS_METRIC_ID]: isSuccessful(session.index) ? 1 : 0,
      });
      expect(rows.every((r) => r.variant === session.variant && r.run_id === RUN_ID)).toBe(true);
    }
  });

  it('stamps every row of every table with the results contract', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    await runLifecycle(exporter, { sessions: 2, eventsPerSession: 2 });
    await exporter.close();
    const tables = [
      [PARQUET_FILES.sessions, CURRENT_REQUIRED_SET.session_row],
      [PARQUET_FILES.events, CURRENT_REQUIRED_SET.event_row],
      [PARQUET_FILES.exposures, CURRENT_REQUIRED_SET.exposure_row],
      [PARQUET_FILES.metricValues, CURRENT_REQUIRED_SET.metric_value_row],
    ] as const;
    for (const [file, requiredSet] of tables) {
      const { rows } = await readTable(join(dir, RUN_ID, file));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          schema_version: CONTRACT_SCHEMA_VERSION,
          required_set: requiredSet,
        });
      }
    }
  });

  it('writes valid empty tables for a run without sessions', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    await runLifecycle(exporter, { sessions: 0 });
    await exporter.close();
    for (const file of Object.values(PARQUET_FILES)) {
      const table = await readTable(join(dir, RUN_ID, file));
      expect(table.numRows).toBe(0);
      expect(table.rows).toEqual([]);
      expect(table.columns.length).toBeGreaterThan(0);
    }
  });

  it('writes on close when the run never finished, and picks up rows added after runFinished', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    await exporter.runStarted(makeRun());
    await exporter.sessionFinished(makeSession(0));
    await exporter.close();
    expect((await readTable(join(dir, RUN_ID, PARQUET_FILES.sessions))).numRows).toBe(1);

    const second = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    await runLifecycle(second, { sessions: 1, eventsPerSession: 1 });
    await second.sessionFinished(makeSession(7));
    await second.close();
    expect((await readTable(join(dir, RUN_ID, PARQUET_FILES.sessions))).numRows).toBe(2);
  });

  it('refuses events without simulation markers before buffering anything', async () => {
    const exporter = new ParquetExporter({ type: 'parquet', path: dir }, makeContext());
    await exporter.runStarted(makeRun());
    await expect(exporter.events([makeUnmarkedEvent(makeSession(0))])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(exporter.rowCounts().events).toBe(0);
    await exporter.close();
    expect((await readTable(join(dir, RUN_ID, PARQUET_FILES.events))).numRows).toBe(0);
  });
});
