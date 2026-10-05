import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AgonEventSchema, SessionSchema, StepSchema, ValidationError } from '@agon/spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_ID,
  makeContext,
  makeRun,
  makeSession,
  makeTempDir,
  makeUnmarkedEvent,
  removeDir,
  runLifecycle,
} from './__fixtures__/fixtures.js';
import type { JsonlManifest } from './jsonl.js';
import { JSONL_FILES, JsonlExporter } from './jsonl.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await removeDir(dir);
});

async function readLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('JsonlExporter', () => {
  it('writes every file under <path>/<runId> and rows round-trip through JSON.parse', async () => {
    const exporter = new JsonlExporter({ type: 'jsonl', path: dir }, makeContext());
    const data = await runLifecycle(exporter, {
      sessions: 3,
      stepsPerSession: 2,
      eventsPerSession: 2,
    });
    await exporter.close();

    const runDir = join(dir, RUN_ID);
    expect(exporter.dir).toBe(runDir);
    expect((await readdir(runDir)).sort()).toEqual(
      [
        JSONL_FILES.events,
        JSONL_FILES.manifest,
        JSONL_FILES.result,
        JSONL_FILES.run,
        JSONL_FILES.sessions,
        JSONL_FILES.steps,
      ].sort(),
    );

    const sessions = await readLines(join(runDir, JSONL_FILES.sessions));
    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => SessionSchema.parse(s))).toEqual(data.sessions);

    const steps = await readLines(join(runDir, JSONL_FILES.steps));
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => StepSchema.parse(s))).toEqual(data.steps);

    const events = await readLines(join(runDir, JSONL_FILES.events));
    expect(events).toHaveLength(6);
    expect(events.map((e) => AgonEventSchema.parse(e))).toEqual(data.events);

    const run = JSON.parse(await readFile(join(runDir, JSONL_FILES.run), 'utf8')) as {
      status: string;
    };
    expect(run.status).toBe('completed');
    const result = JSON.parse(await readFile(join(runDir, JSONL_FILES.result), 'utf8')) as {
      id: string;
    };
    expect(result.id).toBe(data.result?.id);
  });

  it('writes a manifest listing files with row counts', async () => {
    const exporter = new JsonlExporter({ type: 'jsonl', path: dir }, makeContext());
    await runLifecycle(exporter, { sessions: 2, stepsPerSession: 3, eventsPerSession: 1 });
    await exporter.close();

    const manifest = JSON.parse(
      await readFile(join(dir, RUN_ID, JSONL_FILES.manifest), 'utf8'),
    ) as JsonlManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.runId).toBe(RUN_ID);
    const rows = Object.fromEntries(manifest.files.map((f) => [f.file, f.rows]));
    expect(rows).toEqual({
      [JSONL_FILES.run]: 1,
      [JSONL_FILES.sessions]: 2,
      [JSONL_FILES.steps]: 6,
      [JSONL_FILES.events]: 2,
      [JSONL_FILES.result]: 1,
    });
    for (const file of manifest.files) expect(file.bytes).toBeGreaterThan(0);
  });

  it('refuses events without simulation markers and writes nothing for them', async () => {
    const exporter = new JsonlExporter({ type: 'jsonl', path: dir }, makeContext());
    const session = makeSession(0);
    await exporter.runStarted(makeRun());
    await expect(exporter.events([makeUnmarkedEvent(session)])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await exporter.close();
    expect(await readLines(join(dir, RUN_ID, JSONL_FILES.events))).toEqual([]);
  });

  it('keeps concurrent appends intact', async () => {
    const exporter = new JsonlExporter({ type: 'jsonl', path: dir }, makeContext());
    const sessions = Array.from({ length: 20 }, (_, i) => makeSession(i));
    await Promise.all(sessions.map((s) => exporter.sessionFinished(s)));
    await exporter.close();
    const lines = await readLines(join(dir, RUN_ID, JSONL_FILES.sessions));
    expect(lines.map((s) => SessionSchema.parse(s).id).sort()).toEqual(
      sessions.map((s) => s.id).sort(),
    );
  });

  it('does nothing on close when nothing was exported', async () => {
    const exporter = new JsonlExporter({ type: 'jsonl', path: dir }, makeContext());
    await exporter.close();
    await expect(readdir(join(dir, RUN_ID))).rejects.toThrow();
  });
});
