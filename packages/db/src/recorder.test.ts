import type { Session, Step } from '@agon/spec';
import { expect, it } from 'vitest';
import { createDbRecorder, environments, events, results, runs, sessions, steps } from './index.js';
import { describeDb, useTestDb } from './testing/db.js';
import {
  at,
  config,
  makeEvent,
  makeResult,
  makeRun,
  makeSession,
  makeStep,
} from './testing/fixtures.js';

describeDb('createDbRecorder', () => {
  const t = useTestDb();

  it('records a run with two sessions, their steps and events, and the result', async () => {
    const recorder = createDbRecorder(t.db);
    const env = await environments.create(t.db, { config });
    const run = makeRun(env.id, {
      status: 'running',
      startedAt: at(0),
      counts: { planned: 2, running: 0, completed: 0, failed: 0, interrupted: 0 },
    });
    await recorder.runStarted(run);
    expect(await runs.get(t.db, run.id)).toEqual(run);

    const finishedSessions: Session[] = [];
    const stepsBySession = new Map<string, Step[]>();
    for (const index of [0, 1]) {
      const session = makeSession(run, index);
      await recorder.sessionStarted(session);
      const sessionSteps = [0, 1].map((i) => makeStep(session, i));
      for (const step of sessionSteps) await recorder.step(step, new Uint8Array([1, 2, 3]));
      stepsBySession.set(session.id, sessionSteps);
      await recorder.events([
        makeEvent(session, 0, '$pageview'),
        makeEvent(session, 1, 'project_created'),
      ]);
      const finished: Session = {
        ...session,
        status: 'finished',
        outcome: 'success',
        steps: 2,
        costUsd: 0.008,
        inputTokens: 2400,
        outputTokens: 160,
        metrics: { activation: 1 },
        finishedAt: at(10 + index),
      };
      await recorder.sessionFinished(finished);
      finishedSessions.push(finished);
    }

    const result = makeResult(run);
    const finishedRun = {
      ...run,
      status: 'completed' as const,
      counts: { planned: 2, running: 0, completed: 2, failed: 0, interrupted: 0 },
      costUsd: 0.016,
      finishedAt: at(20),
    };
    await recorder.runFinished(finishedRun, result);

    expect(await runs.get(t.db, run.id)).toEqual({ ...finishedRun, resultId: result.id });
    expect((await sessions.listByRun(t.db, run.id)).items).toEqual(finishedSessions);
    for (const session of finishedSessions) {
      expect(await steps.listBySession(t.db, session.id)).toEqual(stepsBySession.get(session.id));
      expect((await events.listBySession(t.db, session.id)).map((e) => e.event)).toEqual([
        '$pageview',
        'project_created',
      ]);
    }
    expect((await events.listByRun(t.db, run.id)).items).toHaveLength(4);
    expect(await results.getByRun(t.db, run.id)).toEqual(result);
  });

  it('finishes a run without a result and tolerates a repeated finish', async () => {
    const recorder = createDbRecorder(t.db);
    const env = await environments.create(t.db, { config });
    const run = makeRun(env.id);
    await recorder.runStarted(run);
    const failed = {
      ...run,
      status: 'failed' as const,
      error: 'budget exceeded',
      finishedAt: at(3),
    };
    await recorder.runFinished(failed);
    await recorder.runFinished(failed);
    expect(await runs.get(t.db, run.id)).toEqual(failed);
    expect(await results.findByRun(t.db, run.id)).toBeUndefined();

    const result = makeResult(run);
    await recorder.runFinished({ ...failed, status: 'completed' }, result);
    await recorder.runFinished({ ...failed, status: 'completed' }, result);
    expect((await runs.get(t.db, run.id)).resultId).toBe(result.id);
  });
});
