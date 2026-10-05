import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import { ValidationError } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import {
  makeEvent,
  makeRun,
  makeSession,
  makeUnmarkedEvent,
  runLifecycle,
} from './__fixtures__/fixtures.js';
import type { Exporter } from './exporter.js';
import { ExportError, FailureCollector } from './exporter.js';
import { MultiExporter } from './multi.js';

class RecordingExporter implements Exporter {
  readonly calls: string[] = [];
  constructor(readonly name = 'recording') {}
  async runStarted(run: Run): Promise<void> {
    this.calls.push(`runStarted:${run.id}`);
  }
  async sessionFinished(session: Session): Promise<void> {
    this.calls.push(`sessionFinished:${session.id}`);
  }
  async steps(steps: Step[]): Promise<void> {
    this.calls.push(`steps:${steps.length}`);
  }
  async events(events: AgonEvent[]): Promise<void> {
    this.calls.push(`events:${events.length}`);
  }
  async runFinished(run: Run, result?: Result): Promise<void> {
    this.calls.push(`runFinished:${run.status}:${result?.id ?? 'none'}`);
  }
  async close(): Promise<void> {
    this.calls.push('close');
  }
}

class FailingExporter extends RecordingExporter {
  constructor(private readonly failOn: Set<string>) {
    super('failing');
  }
  override async events(events: AgonEvent[]): Promise<void> {
    await super.events(events);
    if (this.failOn.has('events')) throw new Error('events boom');
  }
  override async close(): Promise<void> {
    await super.close();
    if (this.failOn.has('close')) {
      const failures = new FailureCollector('failing');
      failures.record('flush', new Error('flush boom'));
      failures.throwIfAny();
    }
  }
}

describe('MultiExporter', () => {
  it('fans every call out to all sinks', async () => {
    const a = new RecordingExporter('a');
    const b = new RecordingExporter('b');
    const multi = new MultiExporter([a, b]);
    await runLifecycle(multi, { sessions: 2, stepsPerSession: 1, eventsPerSession: 1 });
    await multi.close();
    expect(a.calls).toEqual(b.calls);
    expect(a.calls).toHaveLength(1 + 2 * 3 + 1 + 1);
    expect(a.calls[0]).toMatch(/^runStarted:/);
    expect(a.calls.at(-1)).toBe('close');
    expect(multi.errors()).toEqual([]);
  });

  it('isolates a failing sink, keeps reporting it, and rethrows at close', async () => {
    const good = new RecordingExporter('good');
    const bad = new FailingExporter(new Set(['events']));
    const multi = new MultiExporter([bad, good]);
    const run = makeRun();
    const session = makeSession(0);
    await multi.runStarted(run);
    await expect(multi.events([makeEvent(session, 0)])).resolves.toBeUndefined();
    await expect(multi.events([makeEvent(session, 1)])).resolves.toBeUndefined();
    await multi.sessionFinished(session);
    await multi.runFinished(run);

    expect(good.calls).toEqual([
      `runStarted:${run.id}`,
      'events:1',
      'events:1',
      `sessionFinished:${session.id}`,
      'runFinished:running:none',
    ]);
    expect(multi.errors()).toHaveLength(2);
    expect(multi.errors()[0]).toMatchObject({
      exporter: 'failing',
      operation: 'events',
      message: 'events boom',
    });

    let thrown: unknown;
    try {
      await multi.close();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExportError);
    expect((thrown as ExportError).failures).toHaveLength(2);
    expect((thrown as ExportError).details).toEqual({
      failures: multi.errors().map(({ exporter, operation, message, at }) => ({
        exporter,
        operation,
        message,
        at,
      })),
    });
    expect(good.calls.at(-1)).toBe('close');
  });

  it('flattens a sink ExportError raised at close into its individual failures', async () => {
    const multi = new MultiExporter([
      new FailingExporter(new Set(['close'])),
      new RecordingExporter(),
    ]);
    await multi.runStarted(makeRun());
    await expect(multi.close()).rejects.toBeInstanceOf(ExportError);
    expect(multi.errors()).toEqual([
      expect.objectContaining({ exporter: 'failing', operation: 'flush', message: 'flush boom' }),
    ]);
  });

  it('rejects unmarked events before any sink sees them', async () => {
    const sink = new RecordingExporter();
    const multi = new MultiExporter([sink]);
    await expect(multi.events([makeUnmarkedEvent(makeSession(0))])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(sink.calls).toEqual([]);
    await expect(multi.close()).resolves.toBeUndefined();
  });
});
