import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '@agon/spec';
import { expect, it } from 'vitest';
import { apiKeys, squads } from '../index.js';
import { describeDb, useTestDb } from '../testing/db.js';
import { at } from '../testing/fixtures.js';

describeDb('apiKeys', () => {
  const t = useTestDb();

  it('returns the secret once and stores only its SHA-256 hash', async () => {
    const { key, apiKey } = await apiKeys.create(t.db, {
      role: 'operator',
      label: 'ci',
      createdAt: at(0),
    });
    expect(key).toMatch(/^agon_[A-Za-z0-9_-]{43}$/);
    expect(apiKey.keyHash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(apiKey.keyHash).toBe(apiKeys.hashKey(key));
    expect(apiKey).toEqual({
      id: apiKey.id,
      keyHash: apiKey.keyHash,
      role: 'operator',
      label: 'ci',
      createdAt: at(0),
    });
    expect(JSON.stringify(apiKey)).not.toContain(key);
    expect(apiKeys.isActive(apiKey)).toBe(true);
  });

  it('looks keys up by secret or hash', async () => {
    const { key, apiKey } = await apiKeys.create(t.db, { role: 'observer', label: 'dash' });
    expect(await apiKeys.findByKey(t.db, key)).toEqual(apiKey);
    expect(await apiKeys.findByHash(t.db, apiKeys.hashKey(key))).toEqual(apiKey);
    expect(await apiKeys.findByKey(t.db, `${key}x`)).toBeUndefined();
    expect(await apiKeys.get(t.db, apiKey.id)).toEqual(apiKey);
    await expect(apiKeys.get(t.db, 'key_missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts a supplied secret once', async () => {
    const supplied = 'dev-operator-key-0123456789';
    const { key, apiKey } = await apiKeys.create(t.db, {
      role: 'operator',
      label: 'bootstrap',
      key: supplied,
    });
    expect(key).toBe(supplied);
    expect(await apiKeys.findByKey(t.db, supplied)).toEqual(apiKey);
    await expect(
      apiKeys.create(t.db, { role: 'operator', label: 'again', key: supplied }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      apiKeys.create(t.db, { role: 'operator', label: 'short', key: 'short' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('ties squad keys to a squad and nothing else', async () => {
    const squad = await squads.create(t.db, { slug: 'squad-blue', name: 'Blue' });
    const { apiKey } = await apiKeys.create(t.db, {
      role: 'squad',
      squadId: squad.id,
      label: 'blue bot',
    });
    expect(apiKey.squadId).toBe(squad.id);
    await expect(apiKeys.create(t.db, { role: 'squad', label: 'no squad' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      apiKeys.create(t.db, { role: 'operator', squadId: squad.id, label: 'operator with squad' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apiKeys.create(t.db, { role: 'squad', squadId: 'sqd_missing', label: 'dangling' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await apiKeys.list(t.db, { squadId: squad.id })).map((k) => k.id)).toEqual([apiKey.id]);
  });

  it('records use and revokes idempotently', async () => {
    const { apiKey } = await apiKeys.create(t.db, { role: 'operator', label: 'ci' });
    await apiKeys.touch(t.db, apiKey.id, at(1));
    expect((await apiKeys.get(t.db, apiKey.id)).lastUsedAt).toBe(at(1));

    const revoked = await apiKeys.revoke(t.db, apiKey.id, at(2));
    expect(revoked.revokedAt).toBe(at(2));
    expect(apiKeys.isActive(revoked)).toBe(false);
    expect((await apiKeys.revoke(t.db, apiKey.id, at(3))).revokedAt).toBe(at(2));
    await expect(apiKeys.revoke(t.db, 'key_missing')).rejects.toBeInstanceOf(NotFoundError);

    const { apiKey: active } = await apiKeys.create(t.db, { role: 'observer', label: 'live' });
    expect((await apiKeys.list(t.db)).map((k) => k.id)).toEqual([active.id]);
    expect((await apiKeys.list(t.db, { includeRevoked: true })).map((k) => k.id)).toEqual([
      apiKey.id,
      active.id,
    ]);
  });
});
