import { ConflictError, NotFoundError, SquadSchema, ValidationError } from '@agon/spec';
import { expect, it } from 'vitest';
import { squads } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at } from '../testing/fixtures.js';

describeDb('squads', () => {
  const t = useTestDb();

  it('round-trips create -> get / getBySlug with defaults applied', async () => {
    const created = await squads.create(t.db, {
      slug: 'squad-blue',
      name: 'Blue',
      controlUrl: 'https://orchestrator.example.com/agon',
      ticketSource: { kind: 'linear', teamId: 'TEAM1', label: 'agon:paused' },
      createdAt: at(0),
    });
    expect(created.id).toMatch(/^sqd_[0-9a-z]{16}$/);
    expect(created).toEqual(
      SquadSchema.parse({
        id: created.id,
        slug: 'squad-blue',
        name: 'Blue',
        controlUrl: 'https://orchestrator.example.com/agon',
        ticketSource: { kind: 'linear', teamId: 'TEAM1', label: 'agon:paused' },
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    expect(created.score).toEqual({ runs: 0, wins: 0, winRate: 0, meanLift: 0, costUsd: 0 });
    expect(await squads.get(t.db, created.id)).toEqual(created);
    expect(await squads.getBySlug(t.db, 'squad-blue')).toEqual(created);
    expect(await squads.findBySlug(t.db, 'squad-red')).toBeUndefined();
    await expect(squads.getBySlug(t.db, 'squad-red')).rejects.toBeInstanceOf(NotFoundError);
    await expect(squads.get(t.db, 'sqd_missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enforces unique slugs', async () => {
    await squads.create(t.db, { slug: 'squad-blue', name: 'Blue' });
    await expect(
      squads.create(t.db, { slug: 'squad-blue', name: 'Blue 2' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists oldest first with a status filter', async () => {
    await squads.create(t.db, { slug: 'a', name: 'A', createdAt: at(0) });
    await squads.create(t.db, { slug: 'b', name: 'B', createdAt: at(1), status: 'paused' });
    await squads.create(t.db, { slug: 'c', name: 'C', createdAt: at(2) });
    expect((await squads.list(t.db)).map((s) => s.slug)).toEqual(['a', 'b', 'c']);
    expect((await squads.list(t.db, { status: 'active' })).map((s) => s.slug)).toEqual(['a', 'c']);
  });

  it('changes status, allocation, score and details', async () => {
    const squad = await squads.create(t.db, { slug: 'squad-blue', name: 'Blue', createdAt: at(0) });
    const paused = await squads.setStatus(t.db, squad.id, 'paused');
    expect(paused.status).toBe('paused');
    expect(Date.parse(paused.updatedAt)).toBeGreaterThan(Date.parse(at(0)));

    expect((await squads.setAllocation(t.db, squad.id, 0.35)).allocation).toBe(0.35);
    await expect(squads.setAllocation(t.db, squad.id, 1.5)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      squads.create(t.db, { slug: 'x', name: 'X', allocation: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    const scored = await squads.updateScore(t.db, squad.id, { runs: 3, wins: 2, winRate: 2 / 3 });
    expect(scored.score).toEqual({ runs: 3, wins: 2, winRate: 2 / 3, meanLift: 0, costUsd: 0 });
    const scoredAgain = await squads.updateScore(t.db, squad.id, { costUsd: 12.5 });
    expect(scoredAgain.score).toEqual({
      runs: 3,
      wins: 2,
      winRate: 2 / 3,
      meanLift: 0,
      costUsd: 12.5,
    });

    const updated = await squads.update(t.db, squad.id, {
      name: 'Blue Team',
      controlUrl: 'https://orchestrator.example.com/agon',
      ticketSource: { kind: 'github', repo: 'acme/app', label: 'agon:paused' },
    });
    expect(updated).toMatchObject({
      name: 'Blue Team',
      controlUrl: 'https://orchestrator.example.com/agon',
      ticketSource: { kind: 'github', repo: 'acme/app', label: 'agon:paused' },
    });
    const cleared = await squads.update(t.db, squad.id, { controlUrl: null, ticketSource: null });
    expect(cleared.controlUrl).toBeUndefined();
    expect(cleared.ticketSource).toBeUndefined();
    await expect(squads.setStatus(t.db, 'sqd_missing', 'killed')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
