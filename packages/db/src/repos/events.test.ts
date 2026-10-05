import { NotFoundError, ValidationError } from '@agon/spec';
import type { Session } from '@agon/spec';
import { expect, it } from 'vitest';
import { environments, events, runs, sessions } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at, config, makeEvent, makeRun, makeSession } from '../testing/fixtures.js';

describeDb('events', () => {
  const t = useTestDb();

  async function twoSessions(): Promise<[Session, Session]> {
    const env = await environments.create(t.db, { config });
    const r = await runs.create(t.db, makeRun(env.id));
    const a = await sessions.upsert(t.db, makeSession(r, 0));
    const b = await sessions.upsert(t.db, makeSession(r, 1));
    return [a, b];
  }

  it('round-trips insertMany -> listBySession in time order', async () => {
    const [a, b] = await twoSessions();
    const batch = [
      makeEvent(a, 2, 'project_created'),
      makeEvent(a, 0, '$pageview'),
      makeEvent(a, 1, '$agon_click'),
      makeEvent(b, 0, '$pageview'),
    ];
    expect(await events.insertMany(t.db, batch)).toBe(4);
    expect(await events.insertMany(t.db, [])).toBe(0);
    const listed = await events.listBySession(t.db, a.id);
    expect(listed.map((e) => e.event)).toEqual(['$pageview', '$agon_click', 'project_created']);
    expect(listed).toEqual([0, 1, 2].map((i) => batch.find((e) => e.id === makeEvent(a, i).id)));
    expect(await events.listBySession(t.db, b.id)).toEqual([batch[3]]);
  });

  it('refuses events without simulation markers or with unknown sessions', async () => {
    const [a] = await twoSessions();
    const unmarked = { ...makeEvent(a, 0), properties: { plan: 'pro' } };
    await expect(events.insertMany(t.db, [unmarked])).rejects.toBeInstanceOf(ValidationError);
    await expect(
      events.insertMany(t.db, [makeEvent({ ...a, id: 'ses_missing' }, 0)]),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await events.listBySession(t.db, a.id)).toEqual([]);
  });

  it('lists by run in time order with pagination and filters', async () => {
    const [a, b] = await twoSessions();
    // Same timestamp for two events: the id breaks the tie.
    await events.insertMany(t.db, [
      makeEvent(a, 0, '$pageview', { timestamp: at(200) }),
      makeEvent(b, 0, '$pageview', { timestamp: at(200) }),
      makeEvent(a, 1, 'project_created', { timestamp: at(201) }),
      makeEvent(b, 1, '$agon_error', {
        timestamp: at(202),
        source: 'inferred',
        provider: undefined,
      }),
      makeEvent(b, 2, 'project_created', { timestamp: at(203) }),
    ]);
    const page1 = await events.listByRun(t.db, a.runId, { limit: 2 });
    expect(page1.items.map((e) => e.id)).toEqual([makeEvent(a, 0).id, makeEvent(b, 0).id]);
    const page2 = await events.listByRun(t.db, a.runId, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((e) => e.id)).toEqual([makeEvent(a, 1).id, makeEvent(b, 1).id]);
    const page3 = await events.listByRun(t.db, a.runId, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((e) => e.id)).toEqual([makeEvent(b, 2).id]);
    expect(page3.nextCursor).toBeUndefined();

    const created = await events.listByRun(t.db, a.runId, { event: 'project_created' });
    expect(created.items.map((e) => e.sessionId)).toEqual([a.id, b.id]);
    const inferred = await events.listByRun(t.db, a.runId, { source: 'inferred' });
    expect(inferred.items.map((e) => e.event)).toEqual(['$agon_error']);
    expect(inferred.items[0]?.provider).toBeUndefined();
  });
});
