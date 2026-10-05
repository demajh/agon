import type { AgonEvent, Result, Run, Session, Step } from '@agon/spec';
import type { ExportFailure, Exporter, ExporterLogger } from './exporter.js';
import { ExportError, FailureCollector, assertAllSimulated } from './exporter.js';

/**
 * Fans every call out to all sinks. One failing sink never stops the others: rejections are
 * collected (see `errors()`) and rethrown as a single `ExportError` from `close()`.
 * Unmarked events are rejected before any sink sees them.
 */
export class MultiExporter implements Exporter {
  readonly name = 'multi';
  private readonly failures: FailureCollector;

  constructor(
    readonly exporters: readonly Exporter[],
    logger?: ExporterLogger,
  ) {
    this.failures = new FailureCollector(this.name, logger);
  }

  runStarted(run: Run): Promise<void> {
    return this.fanOut('runStarted', (exporter) => exporter.runStarted(run));
  }

  sessionFinished(session: Session): Promise<void> {
    return this.fanOut('sessionFinished', (exporter) => exporter.sessionFinished(session));
  }

  steps(steps: Step[]): Promise<void> {
    return this.fanOut('steps', (exporter) => exporter.steps(steps));
  }

  async events(events: AgonEvent[]): Promise<void> {
    assertAllSimulated(events);
    await this.fanOut('events', (exporter) => exporter.events(events));
  }

  runFinished(run: Run, result?: Result): Promise<void> {
    return this.fanOut('runFinished', (exporter) => exporter.runFinished(run, result));
  }

  async close(): Promise<void> {
    await this.fanOut('close', (exporter) => exporter.close());
    this.failures.throwIfAny();
  }

  /** Every failure of every sink so far, in the order they were observed. */
  errors(): readonly ExportFailure[] {
    return this.failures.list();
  }

  private async fanOut(
    operation: string,
    call: (exporter: Exporter) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(this.exporters.map((exporter) => call(exporter)));
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const exporter = this.exporters[i]?.name ?? 'unknown';
      // A sink's close() reports its own collected failures as one ExportError; keep the list flat.
      if (result.reason instanceof ExportError && result.reason.failures.length > 0) {
        for (const failure of result.reason.failures) this.failures.adopt(failure);
      } else {
        this.failures.record(operation, result.reason, exporter);
      }
    });
  }
}
