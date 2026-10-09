import { describe, expect, it } from 'vitest';
import {
  CONTRACT_REGISTRY,
  CONTRACT_SCHEMA_VERSION,
  CURRENT_REQUIRED_SET,
  REQUIRED_SETS,
  RowKindSchema,
  UNSTAMPED_REQUIRED_SET,
  analyticsStamp,
  checkRow,
  isSuperset,
  missingFields,
  readStamp,
  stampRow,
  stampWarehouseRow,
  timeToReconcileMs,
} from './contract.js';
import { hashValue } from './common.js';
import { ConfigError, ValidationError } from './errors.js';

describe('the required-set registry', () => {
  it('has a current id for every row kind, and every id resolves', () => {
    for (const kind of RowKindSchema.options) {
      const id = CURRENT_REQUIRED_SET[kind];
      expect(REQUIRED_SETS[id], kind).toBeDefined();
      expect(REQUIRED_SETS[id]?.version).toBe(CONTRACT_SCHEMA_VERSION);
    }
    expect(CONTRACT_REGISTRY.generation).toBe(1);
  });

  it('pins the version-1 field lists: an id resolves to the same list forever', () => {
    // Changing any of these lists is a new id, never an edit. Add `agon.<kind>.2` instead.
    expect(REQUIRED_SETS['agon.session.1']?.fields).toEqual([
      'id',
      'runId',
      'index',
      'variant',
      'scenarioId',
      'persona',
      'persona.personaId',
      'persona.model',
      'persona.distinctId',
      'status',
      'steps',
      'costUsd',
      'inputTokens',
      'outputTokens',
      'metrics',
    ]);
    expect(REQUIRED_SETS['agon.result.1']?.fields).toContain('requirementsDigest');
    expect(REQUIRED_SETS['agon.result.1']?.fields).toContain('kind');
    expect(REQUIRED_SETS['agon.event.1']?.fields).toContain('properties.agon_simulated');
    expect(REQUIRED_SETS['agon.metric_value_row.1']?.fields).toEqual([
      'session_id',
      'run_id',
      'variant',
      'metric_id',
      'value',
    ]);
    expect(REQUIRED_SETS['agon.analytics_event.1']?.fields).toEqual([
      'agon_simulated',
      'agon_run_id',
      'agon_session_id',
      'agon_variant',
      'agon_persona',
      'agon_model',
    ]);
    for (const set of Object.values(REQUIRED_SETS)) {
      expect(new Set(set.fields).size).toBe(set.fields.length);
    }
  });

  it('pins every published list by hash, so editing one fails here (publish a new id instead)', () => {
    const PUBLISHED: Record<string, string> = {
      'agon.session.1': '0764805db88f3810dafb56ae363e36426667ce1e051024e8765a717842558b45',
      'agon.step.1': '6d645d42b82077a30839353253b7385ada29b1099a0ab8e174e36f78d4effbaa',
      'agon.event.1': '4302fee95fc3710e3cedc728a134b1bec3326b3d542b3020605cf1112d01e877',
      'agon.result.1': '9d4e37f8bb2f1c1e7e35b26d3b651bb6aee5233d897b6181322d90081200d14f',
      'agon.session_row.1': '8119c9f523bbe4f70bdc01a6a1760bbe00af69d16fadee9deee7f2e7a03616a5',
      'agon.event_row.1': 'f6aeb23da8c6c0268ebc2f5b623355085e73723b6894f6ad678ccd46682b7dc7',
      'agon.exposure_row.1': '4b42b55127c5b76effa21f567b76ae8dfe2cfa0166c7900c318cb724be87d70a',
      'agon.metric_value_row.1': '3c37cde6f4e42ea939dfc8b140a70e2152d1c3f403cc2c96070049b28728925e',
      'agon.analytics_event.1': 'e5f3c22f86615c9bfa78d1ee36364213a0c12a9984dc14cb5ffc93a85b1aecbe',
    };
    // every id in the registry is pinned (a new id is added here when it is published) ...
    expect(Object.keys(REQUIRED_SETS).sort()).toEqual(Object.keys(PUBLISHED).sort());
    // ... and resolves to the list it was published with
    for (const [id, hash] of Object.entries(PUBLISHED)) {
      expect(hashValue(REQUIRED_SETS[id]?.fields), id).toBe(hash);
    }
  });
});

describe('stamping', () => {
  const metricRow = { session_id: 's', run_id: 'r', variant: 'v', metric_id: 'm', value: 1 };

  it('stamps spec objects, warehouse rows and analytics properties in their own spelling', () => {
    const exposure = {
      session_id: 's',
      run_id: 'r',
      variant: 'v',
      experiment_key: 'e',
      exposed_at: null,
    };
    expect(stampWarehouseRow('exposure_row', exposure)).toEqual({
      ...exposure,
      schema_version: CONTRACT_SCHEMA_VERSION,
      required_set: 'agon.exposure_row.1',
    });
    expect(stampWarehouseRow('metric_value_row', metricRow).required_set).toBe(
      'agon.metric_value_row.1',
    );
    const markers = {
      agon_simulated: true,
      agon_run_id: 'r',
      agon_session_id: 's',
      agon_variant: 'v',
      agon_persona: 'p',
      agon_model: 'fake/model',
    };
    expect(analyticsStamp(markers)).toEqual({
      agon_schema_version: CONTRACT_SCHEMA_VERSION,
      agon_required_set: 'agon.analytics_event.1',
    });
    const step = {
      id: 'stp_1',
      sessionId: 's',
      index: 0,
      observation: {},
      decision: {},
      result: {},
      patience: 1,
      usage: {},
      startedAt: 't',
      durationMs: 1,
    };
    expect(stampRow('step', step)).toMatchObject({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requiredSet: 'agon.step.1',
    });
  });

  it('refuses to stamp a row that lacks a field of the set, naming the field', () => {
    expect(() => stampWarehouseRow('metric_value_row', { ...metricRow, value: undefined })).toThrow(
      ValidationError,
    );
    expect(() => stampRow('result', { id: 'res_1' })).toThrow(/missing runId, method/);
    expect(missingFields({ a: { b: null } }, ['a', 'a.b', 'a.c'])).toEqual(['a.c']);
  });

  it('reads the stamp in every spelling, including analytics properties on an event', () => {
    expect(readStamp({ schemaVersion: 'x', requiredSet: 'y' })).toEqual({
      schemaVersion: 'x',
      requiredSet: 'y',
    });
    expect(readStamp({ schema_version: 'x', required_set: 'y' })).toEqual({
      schemaVersion: 'x',
      requiredSet: 'y',
    });
    expect(readStamp({ properties: { agon_schema_version: 'x', agon_required_set: 'y' } })).toEqual(
      { schemaVersion: 'x', requiredSet: 'y' },
    );
    expect(readStamp({ properties: {} })).toBeUndefined();
    expect(readStamp('nope')).toBeUndefined();
  });
});

describe('the superset rule (pure gate core)', () => {
  const registry = {
    generation: 2,
    sets: {
      'agon.metric_value_row.1': REQUIRED_SETS['agon.metric_value_row.1']!,
      'agon.metric_value_row.2': {
        version: '2027-01-01.1',
        fields: [...REQUIRED_SETS['agon.metric_value_row.1']!.fields, 'unit'],
      },
      'vendor.metric_value_row.1': {
        version: '2027-01-01.1',
        fields: ['session_id', 'run_id', 'variant', 'metric_id'],
      },
    },
  };
  const row = stampWarehouseRow('metric_value_row', {
    session_id: 's',
    run_id: 'r',
    variant: 'v',
    metric_id: 'm',
    value: 1,
  });

  it('accepts a row whose set covers the reader, including a later superset', () => {
    expect(checkRow(row, 'agon.metric_value_row.1', registry)).toEqual({
      ok: true,
      requiredSet: 'agon.metric_value_row.1',
      version: CONTRACT_SCHEMA_VERSION,
    });
    const v2 = { ...row, unit: 'ms', required_set: 'agon.metric_value_row.2' };
    expect(checkRow(v2, 'agon.metric_value_row.1', registry).ok).toBe(true);
    expect(
      isSuperset(
        registry.sets['agon.metric_value_row.2'],
        registry.sets['agon.metric_value_row.1'],
      ),
    ).toBe(true);
  });

  it('rejects a row whose set is not a superset, naming what is missing', () => {
    const narrower = { ...row, required_set: 'vendor.metric_value_row.1' };
    expect(checkRow(narrower, 'agon.metric_value_row.1', registry)).toEqual({
      ok: false,
      code: 'REQUIRED_SET_NOT_SUPERSET',
      requiredSet: 'vendor.metric_value_row.1',
      missing: ['value'],
    });
    // an id alone is not enough: the reader wants v2, the row carries v1 which lacks `unit`
    expect(checkRow(row, 'agon.metric_value_row.2', registry)).toMatchObject({
      ok: false,
      code: 'REQUIRED_SET_NOT_SUPERSET',
      missing: ['unit'],
    });
  });

  it('reports an id the registry does not know, and an unstamped row, as unresolved', () => {
    expect(
      checkRow(
        { ...row, required_set: 'agon.metric_value_row.9' },
        'agon.metric_value_row.1',
        registry,
      ),
    ).toEqual({
      ok: false,
      code: 'REQUIRED_SET_UNRESOLVED',
      requiredSet: 'agon.metric_value_row.9',
    });
    expect(checkRow({ session_id: 's' }, 'agon.metric_value_row.1', registry)).toEqual({
      ok: false,
      code: 'REQUIRED_SET_UNRESOLVED',
      requiredSet: UNSTAMPED_REQUIRED_SET,
    });
  });

  it('treats a reader declaring an unknown set as a programming error', () => {
    expect(() => checkRow(row, 'agon.nope.1', registry)).toThrow(ConfigError);
  });

  it('measures time to reconcile on closed lag-ledger entries only', () => {
    const open = {
      requiredSet: 'x',
      generation: 1,
      rows: 1,
      firstSeenAt: '2026-10-09T00:00:00.000Z',
      expiredAt: '2026-10-09T01:00:00.000Z',
    };
    expect(timeToReconcileMs(open)).toBeUndefined();
    expect(
      timeToReconcileMs({
        ...open,
        reconciledAt: '2026-10-09T03:30:00.000Z',
        reconciledGeneration: 2,
      }),
    ).toBe(2.5 * 3_600_000);
  });
});
