import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exporter } from '@agon/exporters';
import type { AgonEvent, Recorder, Result, Run, Session, Step } from '@agon/spec';

export interface CliRecorderOptions {
  /** Where step screenshots are written as `<stepId>.png`; omit to discard them. */
  screenshotDir?: string | undefined;
  onSessionFinished?: ((session: Session) => void) | undefined;
}

/**
 * The CLI's Recorder: forwards everything to the configured exporters (the JSONL sink is always
 * among them), keeps finished sessions for the summary, and writes screenshots to disk.
 */
export class CliRecorder implements Recorder {
  readonly sessions: Session[] = [];
  readonly exportErrors: Error[] = [];
  stepCount = 0;
  eventCount = 0;

  constructor(
    private readonly exporter: Exporter,
    private readonly options: CliRecorderOptions = {},
  ) {}

  async runStarted(run: Run): Promise<void> {
    await this.exporter.runStarted(run);
  }

  async sessionStarted(): Promise<void> {}

  async step(step: Step, screenshot?: Uint8Array): Promise<void> {
    this.stepCount++;
    if (screenshot && this.options.screenshotDir) {
      mkdirSync(this.options.screenshotDir, { recursive: true });
      writeFileSync(join(this.options.screenshotDir, `${step.id}.png`), screenshot);
    }
    await this.exporter.steps([step]);
  }

  async events(events: AgonEvent[]): Promise<void> {
    this.eventCount += events.length;
    await this.exporter.events(events);
  }

  async sessionFinished(session: Session): Promise<void> {
    this.sessions.push(session);
    await this.exporter.sessionFinished(session);
    this.options.onSessionFinished?.(session);
  }

  async runFinished(run: Run, result?: Result): Promise<void> {
    try {
      await this.exporter.runFinished(run, result);
      await this.exporter.close();
    } catch (error) {
      this.exportErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
