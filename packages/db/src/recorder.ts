import type { AgonEvent, Recorder, Result, Run, Session, Step } from '@agon/spec';
import type { Db } from './client.js';
import * as events from './repos/events.js';
import * as results from './repos/results.js';
import * as runs from './repos/runs.js';
import * as sessions from './repos/sessions.js';
import * as steps from './repos/steps.js';

/**
 * A `Recorder` that persists everything the engine reports to Postgres.
 *
 * Every call is durable when its promise resolves, so a crash loses nothing that was awaited.
 * Screenshot bytes are accepted but not stored here; object storage is a separate sink and the
 * step's observation carries the `screenshotRef`.
 */
export function createDbRecorder(db: Db): Recorder {
  return {
    async runStarted(run: Run): Promise<void> {
      await runs.upsert(db, run);
    },
    async sessionStarted(session: Session): Promise<void> {
      await sessions.upsert(db, session);
    },
    async step(step: Step, _screenshot?: Uint8Array): Promise<void> {
      await steps.insertMany(db, [step]);
    },
    async events(batch: AgonEvent[]): Promise<void> {
      await events.insertMany(db, batch);
    },
    async sessionFinished(session: Session): Promise<void> {
      await sessions.upsert(db, session);
    },
    async runFinished(run: Run, result?: Result): Promise<void> {
      await db.transaction(async (tx) => {
        if (result) await results.upsert(tx, result);
        await runs.upsert(tx, result ? { ...run, resultId: result.id } : run);
      });
    },
  };
}
