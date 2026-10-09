import {
  AnalysisKindSchema,
  AnalysisMethodSchema,
  AnalyticsProviderSchema,
  DecisionSchema,
  DecisionStatusSchema,
  EventSourceSchema,
  FindingStatusSchema,
  LedgerEventSchema,
  LedgerRoleSchema,
  PolicyActionSchema,
  RunStatusSchema,
  SessionOutcomeSchema,
  SessionStatusSchema,
  SquadStatusSchema,
} from '@agon/spec';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import type { DrizzleSnapshotJSON } from 'drizzle-kit/api';
import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from './index.js';

describe('migrations', () => {
  it('are in sync with schema.ts (run `pnpm -F @agon/db db:generate` otherwise)', async () => {
    const meta = fileURLToPath(new URL('../drizzle/meta/', import.meta.url));
    const latest = readdirSync(meta)
      .filter((file) => file.endsWith('_snapshot.json'))
      .sort()
      .at(-1);
    expect(latest).toBeDefined();
    const snapshot = JSON.parse(
      readFileSync(join(meta, latest ?? ''), 'utf8'),
    ) as DrizzleSnapshotJSON;
    const pending = await generateMigration(snapshot, generateDrizzleJson(schema, snapshot.id));
    expect(pending).toEqual([]);
  });
});

describe('schema enums', () => {
  it.each([
    ['run_status', schema.runStatus, RunStatusSchema],
    ['session_status', schema.sessionStatus, SessionStatusSchema],
    ['session_outcome', schema.sessionOutcome, SessionOutcomeSchema],
    ['event_source', schema.eventSource, EventSourceSchema],
    ['analytics_provider', schema.analyticsProvider, AnalyticsProviderSchema],
    ['analysis_method', schema.analysisMethod, AnalysisMethodSchema],
    ['squad_status', schema.squadStatus, SquadStatusSchema],
    ['policy_action', schema.policyAction, PolicyActionSchema],
    ['decision_status', schema.decisionStatus, DecisionStatusSchema],
    ['decision_actor', schema.decisionActor, DecisionSchema.shape.actor],
    ['ledger_role', schema.ledgerRole, LedgerRoleSchema],
    ['ledger_event', schema.ledgerEvent, LedgerEventSchema],
    ['result_kind', schema.resultKind, AnalysisKindSchema],
    ['finding_status', schema.findingStatus, FindingStatusSchema],
  ] as const)('%s lists exactly the spec values, in order', (name, pgEnum, zodEnum) => {
    expect(pgEnum.enumName).toBe(name);
    expect([...pgEnum.enumValues]).toEqual(zodEnum.options);
  });
});

describe('schema tables', () => {
  it('declares one table per stored object', () => {
    const names = [
      schema.environments,
      schema.variants,
      schema.runs,
      schema.sessions,
      schema.steps,
      schema.events,
      schema.results,
      schema.squads,
      schema.decisions,
      schema.apiKeys,
      schema.evaluationLedger,
      schema.findings,
    ].map((table) => getTableName(table));
    expect(names).toEqual([
      'environments',
      'variants',
      'runs',
      'sessions',
      'steps',
      'events',
      'results',
      'squads',
      'decisions',
      'api_keys',
      'evaluation_ledger',
      'findings',
    ]);
  });
});
