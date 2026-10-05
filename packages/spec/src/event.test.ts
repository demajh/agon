import { describe, expect, it } from 'vitest';
import { AgonEventSchema, ValidationError, assertSimulated, simProperties } from './index.js';
import type { AgonEvent } from './index.js';

const ctx = {
  runId: 'run_abc',
  sessionId: 'ses_abc_00001',
  variant: 'treatment',
  personaId: 'smb-owner',
  model: 'anthropic/claude-sonnet-5-5',
  scenarioId: 'first-project',
};

function event(properties: Record<string, unknown>): AgonEvent {
  return {
    id: 'evt_1',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    timestamp: '2026-10-04T17:00:00.000Z',
    event: 'project_created',
    distinctId: 'sim_user_1',
    source: 'intercepted',
    provider: 'posthog',
    properties,
  };
}

describe('simulation markers', () => {
  it('simProperties stamps every required marker', () => {
    expect(simProperties(ctx)).toEqual({
      agon_simulated: true,
      agon_run_id: 'run_abc',
      agon_session_id: 'ses_abc_00001',
      agon_variant: 'treatment',
      agon_persona: 'smb-owner',
      agon_model: 'anthropic/claude-sonnet-5-5',
      agon_scenario: 'first-project',
    });
  });

  it('AgonEventSchema accepts marked events and rejects unmarked ones', () => {
    expect(AgonEventSchema.safeParse(event({ ...simProperties(ctx), plan: 'pro' })).success).toBe(
      true,
    );
    const bad = AgonEventSchema.safeParse(event({ plan: 'pro' }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toMatch(/missing simulation markers/);
  });

  it('assertSimulated throws a ValidationError for events that could pass as real traffic', () => {
    expect(() => assertSimulated(event({ ...simProperties(ctx) }))).not.toThrow();
    expect(() => assertSimulated(event({ agon_simulated: true }))).toThrow(ValidationError);
    expect(() => assertSimulated(event({}))).toThrow(/refusing to export/);
  });
});
