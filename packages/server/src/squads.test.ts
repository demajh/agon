import { decisions, squads } from '@agon/db';
import type { Decision, Squad, SquadControlMessage } from '@agon/spec';
import { SquadControlMessageSchema } from '@agon/spec';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LeaderboardEntry } from './schemas.js';
import {
  describeDb,
  startLocalHttpServer,
  useTestServer,
  type LocalHttpServer,
} from './testing/harness.js';

describeDb('squads, decisions and the control protocol', () => {
  let control: LocalHttpServer;
  /** Decision status as seen by the control endpoint while it handled each message. */
  const statusAtDelivery: Record<string, string | undefined> = {};
  let failNext = false;

  const h = useTestServer();

  beforeAll(async () => {
    control = await startLocalHttpServer(async (request) => {
      const message = request.body as SquadControlMessage;
      const row = await decisions.find(h.t.server.db, message.decisionId);
      statusAtDelivery[message.decisionId] = row?.status ?? 'missing';
      if (failNext) {
        failNext = false;
        return 500;
      }
      return 200;
    });
  });
  afterAll(async () => {
    await control.close();
  });

  async function createSquad(slug: string, withControl = true): Promise<Squad> {
    const created = await h.t.request('POST', '/v1/squads', {
      body: { slug, name: slug.toUpperCase(), ...(withControl ? { controlUrl: control.url } : {}) },
    });
    expect(created.status).toBe(201);
    return created.json<Squad>();
  }

  it('creates, lists, gets and patches squads', async () => {
    const blue = await createSquad('blue');
    expect(blue).toMatchObject({
      slug: 'blue',
      status: 'active',
      allocation: 0,
      controlUrl: control.url,
    });
    expect(
      (await h.t.request('POST', '/v1/squads', { body: { slug: 'blue', name: 'again' } })).status,
    ).toBe(409);
    const got = await h.t.request('GET', `/v1/squads/${blue.id}`);
    expect(await got.json()).toEqual(blue);
    const patched = await h.t.request('PATCH', `/v1/squads/${blue.id}`, {
      body: { name: 'Blue Team', controlUrl: null, ticketSource: { kind: 'linear', teamId: 'T1' } },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      name: 'Blue Team',
      ticketSource: { kind: 'linear', teamId: 'T1', label: 'agon:paused' },
    });
    expect((await patched.json<Squad>()).controlUrl).toBeUndefined();
    const listed = await (
      await h.t.request('GET', '/v1/squads?status=active')
    ).json<{ items: Squad[] }>();
    expect(listed.items.map((s) => s.slug)).toEqual(['blue']);
    expect((await h.t.request('GET', '/v1/squads/sqd_missing')).status).toBe(404);
  });

  it('pauses a squad: Decision row first, then status, then the control message', async () => {
    const blue = await createSquad('blue');
    const paused = await h.t.request('POST', `/v1/squads/${blue.id}/pause`, {
      body: { reason: 'Regressions in the last three runs' },
    });
    expect(paused.status).toBe(200);
    const { squad, decision } = await paused.json<{ squad: Squad; decision: Decision }>();
    expect(squad.status).toBe('paused');
    expect(decision).toMatchObject({
      kind: 'pause',
      status: 'executed',
      squadId: blue.id,
      actor: 'human',
      rationale: 'Regressions in the last three runs',
    });
    expect(decision.decidedAt).toBeDefined();
    expect(decision.executedAt).toBeDefined();

    expect(control.requests).toHaveLength(1);
    const message = SquadControlMessageSchema.parse(control.requests[0]!.body);
    expect(message).toMatchObject({
      action: 'pause',
      squadId: blue.id,
      squad: 'blue',
      decisionId: decision.id,
      reason: decision.rationale,
    });
    expect(control.requests[0]!.headers['x-agon-action']).toBe('pause');
    // Invariant 6: the decision existed (approved) before the webhook fired.
    expect(statusAtDelivery[decision.id]).toBe('approved');

    expect(
      (await h.t.request('POST', `/v1/squads/${blue.id}/pause`, { body: { reason: 'again' } }))
        .status,
    ).toBe(409);
    const resumed = await (
      await h.t.request('POST', `/v1/squads/${blue.id}/resume`, { body: { reason: 'fixed' } })
    ).json<{ squad: Squad; decision: Decision }>();
    expect(resumed.squad.status).toBe('active');
    expect(resumed.decision.kind).toBe('resume');
    expect(control.requests.map((r) => (r.body as SquadControlMessage).action)).toEqual([
      'pause',
      'resume',
    ]);
  });

  it('kills a squad, zeroes its allocation, and records webhook failures on the decision', async () => {
    const red = await createSquad('red');
    await squads.setAllocation(h.t.server.db, red.id, 0.5);
    failNext = true;
    const killed = await h.t.request('POST', `/v1/squads/${red.id}/kill`, {
      body: { reason: 'Shipping nothing for a month' },
    });
    expect(killed.status).toBe(200);
    const { squad, decision } = await killed.json<{ squad: Squad; decision: Decision }>();
    expect(squad.status).toBe('killed');
    expect(squad.allocation).toBe(0);
    expect(decision.status).toBe('failed');
    expect(decision.error).toMatch(/500/);
    expect(statusAtDelivery[decision.id]).toBe('approved');
    const message = control.requests.at(-1)!.body as SquadControlMessage;
    expect(message).toMatchObject({ action: 'kill', allocation: 0 });
    expect(
      (await h.t.request('POST', `/v1/squads/${red.id}/resume`, { body: { reason: 'oops' } }))
        .status,
    ).toBe(409);

    // No control URL: the action still works and the decision executes.
    const quiet = await createSquad('quiet', false);
    const paused = await (
      await h.t.request('POST', `/v1/squads/${quiet.id}/pause`, { body: { reason: 'r' } })
    ).json<{ decision: Decision }>();
    expect(paused.decision.status).toBe('executed');
  });

  it('proposes instead of acting when approval is human, until approved or rejected', async () => {
    const blue = await createSquad('blue');
    const before = control.requests.length;
    const proposed = await h.t.request('POST', `/v1/squads/${blue.id}/pause`, {
      body: { reason: 'Needs a second pair of eyes', approval: 'human' },
    });
    expect(proposed.status).toBe(200);
    const { squad, decision } = await proposed.json<{ squad: Squad; decision: Decision }>();
    expect(squad.status).toBe('active');
    expect(decision.status).toBe('proposed');
    expect(control.requests).toHaveLength(before);

    const listedProposed = await (
      await h.t.request('GET', `/v1/decisions?status=proposed&squadId=${blue.id}`)
    ).json<{ items: Decision[] }>();
    expect(listedProposed.items.map((d) => d.id)).toEqual([decision.id]);

    const approved = await h.t.request('POST', `/v1/decisions/${decision.id}/approve`);
    expect(approved.status).toBe(200);
    expect((await approved.json<Decision>()).status).toBe('executed');
    expect((await (await h.t.request('GET', `/v1/squads/${blue.id}`)).json<Squad>()).status).toBe(
      'paused',
    );
    expect(control.requests).toHaveLength(before + 1);
    expect(statusAtDelivery[decision.id]).toBe('approved');
    expect((await h.t.request('POST', `/v1/decisions/${decision.id}/approve`)).status).toBe(409);

    const second = await (
      await h.t.request('POST', `/v1/squads/${blue.id}/resume`, {
        body: { reason: 'r', approval: 'human' },
      })
    ).json<{ decision: Decision }>();
    const rejected = await h.t.request('POST', `/v1/decisions/${second.decision.id}/reject`);
    expect(rejected.status).toBe(200);
    expect((await rejected.json<Decision>()).status).toBe('rejected');
    expect((await (await h.t.request('GET', `/v1/squads/${blue.id}`)).json<Squad>()).status).toBe(
      'paused',
    );
    expect((await h.t.request('POST', `/v1/decisions/${second.decision.id}/reject`)).status).toBe(
      409,
    );
    expect((await h.t.request('GET', `/v1/decisions/${second.decision.id}`)).status).toBe(200);
    expect((await h.t.request('GET', '/v1/decisions/dec_missing')).status).toBe(404);
  });

  it('ranks the leaderboard by win rate then mean lift', async () => {
    const a = await createSquad('alpha', false);
    const b = await createSquad('beta', false);
    const c = await createSquad('gamma', false);
    await squads.updateScore(h.t.server.db, a.id, {
      runs: 4,
      wins: 2,
      winRate: 0.5,
      meanLift: 0.1,
    });
    await squads.updateScore(h.t.server.db, b.id, {
      runs: 4,
      wins: 2,
      winRate: 0.5,
      meanLift: 0.2,
    });
    await squads.updateScore(h.t.server.db, c.id, { runs: 2, wins: 2, winRate: 1, meanLift: 0.05 });
    await squads.setAllocation(h.t.server.db, c.id, 0.6);
    const board = await h.t.request('GET', '/v1/squads/leaderboard');
    expect(board.status).toBe(200);
    const { items } = await board.json<{ items: LeaderboardEntry[] }>();
    expect(items.map((e) => [e.rank, e.slug])).toEqual([
      [1, 'gamma'],
      [2, 'beta'],
      [3, 'alpha'],
    ]);
    expect(items[0]).toMatchObject({ allocation: 0.6, status: 'active', score: { winRate: 1 } });
  });

  it('reallocates over active squads through one reallocate decision', async () => {
    const blue = await createSquad('blue');
    const red = await createSquad('red');
    const dead = await createSquad('dead', false);
    await squads.updateScore(h.t.server.db, blue.id, { runs: 10, wins: 8, winRate: 0.8 });
    await squads.updateScore(h.t.server.db, red.id, { runs: 10, wins: 2, winRate: 0.2 });
    await h.t.request('POST', `/v1/squads/${dead.id}/kill`, { body: { reason: 'gone' } });
    const before = control.requests.length;

    const response = await h.t.request('POST', '/v1/squads/reallocate', {
      body: { floor: 0.2, seed: 1 },
    });
    expect(response.status).toBe(200);
    const {
      decision,
      allocation,
      squads: after,
    } = await response.json<{
      decision: Decision;
      allocation: Record<string, number>;
      squads: Squad[];
    }>();
    expect(decision).toMatchObject({ kind: 'reallocate', status: 'executed', actor: 'human' });
    expect(decision.squadId).toBeUndefined();
    expect(Object.keys(allocation).sort()).toEqual(['blue', 'red']);
    const total = Object.values(allocation).reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(allocation['blue']!).toBeGreaterThan(allocation['red']!);
    expect(allocation['red']!).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(after.find((s) => s.slug === 'blue')?.allocation).toBeCloseTo(allocation['blue']!, 9);
    expect(after.find((s) => s.slug === 'dead')?.allocation).toBe(0);
    expect(decision.payload).toMatchObject({ floor: 0.2, method: 'thompson', allocation });

    const messages = control.requests.slice(before).map((r) => r.body as SquadControlMessage);
    expect(messages.map((m) => m.action)).toEqual(['reallocate', 'reallocate']);
    expect(messages.map((m) => m.squad).sort()).toEqual(['blue', 'red']);
    for (const m of messages) {
      expect(m.allocation).toBeCloseTo(allocation[m.squad]!, 9);
      expect(statusAtDelivery[m.decisionId]).toBe('approved');
    }
    expect(
      (await h.t.request('POST', '/v1/squads/reallocate', { body: { floor: 0.6 } })).status,
    ).toBe(409);
  });

  it('refuses to reallocate without active squads and lists decisions with filters', async () => {
    expect((await h.t.request('POST', '/v1/squads/reallocate', { body: {} })).status).toBe(409);
    const blue = await createSquad('blue', false);
    await h.t.request('POST', `/v1/squads/${blue.id}/pause`, { body: { reason: 'a' } });
    await h.t.request('POST', `/v1/squads/${blue.id}/resume`, { body: { reason: 'b' } });
    const all = await (await h.t.request('GET', '/v1/decisions')).json<{ items: Decision[] }>();
    expect(all.items.map((d) => d.kind)).toEqual(['resume', 'pause']);
    const pauses = await (
      await h.t.request('GET', '/v1/decisions?kind=pause')
    ).json<{ items: Decision[] }>();
    expect(pauses.items.map((d) => d.kind)).toEqual(['pause']);
    const page = await (
      await h.t.request('GET', '/v1/decisions?limit=1')
    ).json<{ items: Decision[]; nextCursor?: string }>();
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect((await h.t.request('GET', '/v1/decisions?kind=explode')).status).toBe(400);
  });
});
