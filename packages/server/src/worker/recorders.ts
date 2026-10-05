import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runs, type Db } from '@agon/db';
import type { Exporter } from '@agon/exporters';
import type { AgonEvent, Recorder, Result, Run, Session, Step } from '@agon/spec';

/** Fans every recorder call out to all recorders, in order, awaiting each. */
export function composeRecorders(...recorders: readonly Recorder[]): Recorder {
  const each = async (call: (recorder: Recorder) => Promise<void>): Promise<void> => {
    for (const recorder of recorders) await call(recorder);
  };
  return {
    runStarted: (run) => each((r) => r.runStarted(run)),
    sessionStarted: (session) => each((r) => r.sessionStarted(session)),
    step: (step, screenshot) => each((r) => r.step(step, screenshot)),
    events: (events) => each((r) => r.events(events)),
    sessionFinished: (session) => each((r) => r.sessionFinished(session)),
    runFinished: (run, result) => each((r) => r.runFinished(run, result)),
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** `<dir>/<runId>/<stepId>.png`; throws when an id could escape the directory. */
export function screenshotPath(dir: string, runId: string, stepId: string): string {
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(stepId)) {
    throw new RangeError('screenshot ids must be [A-Za-z0-9_-]');
  }
  return join(dir, runId, `${stepId}.png`);
}

/** Writes step screenshots to `<dir>/<runId>/<stepId>.png`; everything else is a no-op. */
export function createScreenshotRecorder(dir: string): Recorder {
  const ready = new Map<string, Promise<void>>();
  const ensureDir = (runId: string): Promise<void> => {
    let pending = ready.get(runId);
    if (!pending) {
      pending = mkdir(join(dir, runId), { recursive: true }).then(() => undefined);
      ready.set(runId, pending);
    }
    return pending;
  };
  return {
    async runStarted() {},
    async sessionStarted() {},
    async step(step: Step, screenshot?: Uint8Array) {
      if (!screenshot) return;
      const runId = runIdOf(step.sessionId);
      await ensureDir(runId);
      await writeFile(screenshotPath(dir, runId, step.id), screenshot);
    },
    async events() {},
    async sessionFinished() {},
    async runFinished() {},
  };
}

/**
 * Session ids are `ses_<run suffix>_<index>`; the run is `run_<run suffix>`. Steps only carry a
 * session id, so the screenshot recorder derives the run from it.
 */
export function runIdOf(sessionId: string): string {
  const m = /^ses_(.+)_\d+$/.exec(sessionId);
  return m ? `run_${m[1]}` : sessionId;
}

/**
 * Keeps the run row's `counts` and `costUsd` current while sessions run, so `GET /v1/runs/{id}`
 * shows progress. The engine's final `runFinished` upsert writes the same totals.
 */
export function createProgressRecorder(db: Db): Recorder {
  return {
    async runStarted() {},
    async sessionStarted(session: Session) {
      await runs.bumpCounts(db, session.runId, { running: 1 });
    },
    async step() {},
    async events() {},
    async sessionFinished(session: Session) {
      await runs.bumpCounts(db, session.runId, {
        running: -1,
        ...(session.status === 'failed' ? { failed: 1 } : { completed: 1 }),
      });
      if (session.costUsd > 0) await runs.addCost(db, session.runId, session.costUsd);
    },
    async runFinished() {},
  };
}

/**
 * Forwards steps, events and sessions to the configured exporters. `runStarted` opens the sinks;
 * `runFinished` is deliberately not forwarded: the worker closes the exporter itself once the
 * Result exists, so sinks receive run and result together.
 */
export function createExporterRecorder(exporter: Exporter): Recorder {
  return {
    runStarted: (run: Run) => exporter.runStarted(run),
    async sessionStarted() {},
    step: (step: Step) => exporter.steps([step]),
    events: (events: AgonEvent[]) => exporter.events(events),
    sessionFinished: (session: Session) => exporter.sessionFinished(session),
    async runFinished(_run: Run, _result?: Result) {},
  };
}
