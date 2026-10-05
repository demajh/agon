import { decisions, squads } from '@agon/db';
import { ConflictError, type Decision, type Squad } from '@agon/spec';
import type { AppContext } from '../context.js';
import { assertActionAllowed, executeDecision, type SquadAction } from './executor.js';

export type Approval = 'auto' | 'human';

export interface DecideInput {
  kind: Decision['kind'];
  squadId?: string | undefined;
  policyId?: string | undefined;
  actor: Decision['actor'];
  rationale: string;
  evidence?: Partial<Decision['evidence']> | undefined;
  payload?: Record<string, unknown> | undefined;
  /** `human` records a proposal and stops; `auto` approves and executes immediately. */
  approval: Approval;
}

/**
 * The single path every governance action takes: write the Decision row first, then (unless a
 * human must approve) execute it. Nothing in this package changes a squad without going through
 * here or `executeDecision` (CLAUDE.md invariant 6).
 */
export async function decide(ctx: AppContext, input: DecideInput): Promise<Decision> {
  const inserted = await decisions.insert(ctx.db, {
    kind: input.kind,
    status: input.approval === 'human' ? 'proposed' : 'approved',
    squadId: input.squadId,
    policyId: input.policyId,
    actor: input.actor,
    rationale: input.rationale,
    evidence: input.evidence,
    payload: input.payload,
  });
  if (inserted.status === 'proposed') {
    ctx.logger.info(
      { decisionId: inserted.id, kind: inserted.kind, squadId: inserted.squadId },
      'decision proposed, awaiting approval',
    );
    await ctx.webhooks.emit('decision.proposed', { decision: inserted });
    return inserted;
  }
  // Stamp decidedAt: the row was born approved, which `insert` does not record.
  const approved = await decisions.setStatus(ctx.db, inserted.id, 'approved');
  return executeDecision(ctx, approved);
}

export interface SquadActionInput {
  reason: string;
  approval?: Approval | undefined;
  actor?: Decision['actor'] | undefined;
  policyId?: string | undefined;
  evidence?: Partial<Decision['evidence']> | undefined;
}

/** Pause, resume or kill a squad through a Decision. */
export async function actOnSquad(
  ctx: AppContext,
  squadId: string,
  action: SquadAction,
  input: SquadActionInput,
): Promise<{ squad: Squad; decision: Decision }> {
  const squad = await squads.get(ctx.db, squadId);
  assertActionAllowed(squad, action);
  const decision = await decide(ctx, {
    kind: action,
    squadId: squad.id,
    policyId: input.policyId,
    actor: input.actor ?? 'human',
    rationale: input.reason,
    evidence: input.evidence,
    payload: { squad: squad.slug, action },
    approval: input.approval ?? 'auto',
  });
  return { squad: await squads.get(ctx.db, squad.id), decision };
}

export interface ReallocateInput {
  floor?: number | undefined;
  seed?: number | undefined;
  reason?: string | undefined;
  approval?: Approval | undefined;
  actor?: Decision['actor'] | undefined;
  policyId?: string | undefined;
  evidence?: Partial<Decision['evidence']> | undefined;
}

export interface ReallocateOutcome {
  decision: Decision;
  allocation: Record<string, number>;
  squads: Squad[];
}

export const DEFAULT_ALLOCATION_FLOOR = 0.1;

/** Thompson-sampling allocation over the active squads, recorded as one `reallocate` Decision. */
export async function reallocate(
  ctx: AppContext,
  input: ReallocateInput,
): Promise<ReallocateOutcome> {
  const active = await squads.list(ctx.db, { status: 'active' });
  if (active.length === 0) throw new ConflictError('no active squads to allocate across');
  const floor = input.floor ?? DEFAULT_ALLOCATION_FLOOR;
  if (floor * active.length > 1 + 1e-9) {
    throw new ConflictError(
      `floor ${floor} is too high for ${active.length} active squads (floor * squads must be <= 1)`,
    );
  }
  const allocation = await ctx.stats.allocate(
    active.map((s) => ({ squad: s.slug, wins: s.score.wins, runs: s.score.runs })),
    { floor, seed: input.seed },
  );
  const decision = await decide(ctx, {
    kind: 'reallocate',
    policyId: input.policyId,
    actor: input.actor ?? 'human',
    rationale:
      input.reason ??
      `Thompson allocation over ${active.length} active squad(s) with a ${floor} floor`,
    evidence: {
      ...input.evidence,
      metrics: {
        ...input.evidence?.metrics,
        ...Object.fromEntries(
          Object.entries(allocation).map(([slug, share]) => [`allocation.${slug}`, share]),
        ),
      },
    },
    payload: { allocation, floor, method: 'thompson' },
    approval: input.approval ?? 'auto',
  });
  return { decision, allocation, squads: await squads.list(ctx.db) };
}

/** Approves a proposed decision and executes it. */
export async function approveDecision(ctx: AppContext, id: string): Promise<Decision> {
  const decision = await decisions.get(ctx.db, id);
  if (decision.status !== 'proposed') {
    throw new ConflictError(
      `decision ${id} is ${decision.status}; only proposed decisions can be approved`,
    );
  }
  if (decision.squadId && decision.kind !== 'reallocate' && decision.kind !== 'notify') {
    const squad = await squads.get(ctx.db, decision.squadId);
    assertActionAllowed(squad, decision.kind);
  }
  const approved = await decisions.setStatus(ctx.db, id, 'approved');
  return executeDecision(ctx, approved);
}

/** Declines a proposed decision. The row stays for the audit trail. */
export async function rejectDecision(ctx: AppContext, id: string): Promise<Decision> {
  const decision = await decisions.get(ctx.db, id);
  if (decision.status !== 'proposed') {
    throw new ConflictError(
      `decision ${id} is ${decision.status}; only proposed decisions can be rejected`,
    );
  }
  const rejected = await decisions.setStatus(ctx.db, id, 'rejected');
  await ctx.webhooks.emit('decision.made', { decision: rejected });
  return rejected;
}
