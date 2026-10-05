import { basename, join, resolve } from 'node:path';
import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import { nowIso } from '@agon/spec';
import type { Exporter, ExporterContext, JsonlExportConfig } from './exporter.js';
import { assertAllSimulated } from './exporter.js';
import { AppendFile, ensureDir, writeFileAtomic } from './fs.js';

export const JSONL_FILES = {
  run: 'run.json',
  sessions: 'sessions.jsonl',
  steps: 'steps.jsonl',
  events: 'events.jsonl',
  result: 'result.json',
  manifest: 'manifest.json',
} as const;

export interface JsonlManifestFile {
  file: string;
  format: 'json' | 'jsonl';
  rows: number;
  bytes: number;
}

export interface JsonlManifest {
  version: 1;
  runId: string;
  experimentName: string;
  writtenAt: string;
  files: JsonlManifestFile[];
}

/**
 * Writes a run to `<path>/<runId>/`: `run.json` (rewritten on finish), `sessions.jsonl`,
 * `steps.jsonl`, `events.jsonl` (append streams, flushed and fsynced on close), `result.json`
 * when a result exists, and a `manifest.json` listing every file with its row count.
 * One JSON document per line; rows round-trip through `JSON.parse`.
 */
export class JsonlExporter implements Exporter {
  readonly name = 'jsonl';
  readonly dir: string;
  private readonly sessionsFile: AppendFile;
  private readonly stepsFile: AppendFile;
  private readonly eventsFile: AppendFile;
  private readonly documents = new Map<string, number>();
  private opening: Promise<void> | undefined;
  private closed = false;

  constructor(
    config: JsonlExportConfig,
    private readonly ctx: ExporterContext,
  ) {
    this.dir = resolve(config.path, ctx.runId);
    this.sessionsFile = new AppendFile(join(this.dir, JSONL_FILES.sessions));
    this.stepsFile = new AppendFile(join(this.dir, JSONL_FILES.steps));
    this.eventsFile = new AppendFile(join(this.dir, JSONL_FILES.events));
  }

  async runStarted(run: Run): Promise<void> {
    await this.open();
    await this.writeDocument(JSONL_FILES.run, run);
    this.ctx.logger?.info(
      { exporter: this.name, runId: run.id, dir: this.dir },
      'jsonl export started',
    );
  }

  async sessionFinished(session: Session): Promise<void> {
    await this.open();
    await this.sessionsFile.append([jsonLine(session)]);
  }

  async steps(steps: Step[]): Promise<void> {
    if (steps.length === 0) return;
    await this.open();
    await this.stepsFile.append(steps.map(jsonLine));
  }

  async events(events: AgonEvent[]): Promise<void> {
    assertAllSimulated(events);
    if (events.length === 0) return;
    await this.open();
    await this.eventsFile.append(events.map(jsonLine));
  }

  async runFinished(run: Run, result?: Result): Promise<void> {
    await this.open();
    await this.writeDocument(JSONL_FILES.run, run);
    if (result) await this.writeDocument(JSONL_FILES.result, result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.opening) return; // nothing was ever exported
    await this.opening;
    await Promise.all([this.sessionsFile.close(), this.stepsFile.close(), this.eventsFile.close()]);
    const manifest = this.manifest();
    await this.writeDocument(JSONL_FILES.manifest, manifest);
    this.ctx.logger?.info(
      { exporter: this.name, dir: this.dir, files: manifest.files },
      'jsonl export closed',
    );
  }

  /** Row counts of everything written so far. */
  manifest(): JsonlManifest {
    const files: JsonlManifestFile[] = [];
    const document = (file: string): void => {
      const bytes = this.documents.get(file);
      if (bytes !== undefined) files.push({ file, format: 'json', rows: 1, bytes });
    };
    document(JSONL_FILES.run);
    for (const stream of [this.sessionsFile, this.stepsFile, this.eventsFile]) {
      files.push({
        file: basename(stream.path),
        format: 'jsonl',
        rows: stream.rows,
        bytes: stream.bytes,
      });
    }
    document(JSONL_FILES.result);
    return {
      version: 1,
      runId: this.ctx.runId,
      experimentName: this.ctx.experimentName,
      writtenAt: nowIso(),
      files,
    };
  }

  private open(): Promise<void> {
    this.opening ??= (async () => {
      await ensureDir(this.dir);
      await Promise.all([this.sessionsFile.open(), this.stepsFile.open(), this.eventsFile.open()]);
    })();
    return this.opening;
  }

  private async writeDocument(file: string, value: unknown): Promise<void> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFileAtomic(join(this.dir, file), text);
    this.documents.set(file, Buffer.byteLength(text));
  }
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
