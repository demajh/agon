import { decisions, squads } from '@agon/db';
import {
  ConflictError,
  nowIso,
  type Decision,
  type Squad,
  type SquadControlMessage,
  type SquadStatus,
} from '@agon/spec';
import { z } from 'zod';
import type { AppContext } from '../context.js';

/** Where a decision's `payload.allocation` lives: squad slug -> share. */
const AllocationPayloadSchema = z.object({ allocation: z.record(z.string(), z.number()) });

export type SquadAction = 'pause' | 'resume' | 'kill';

/** The squad status an action leads to. */
export const ACTION_STATUS: Record<SquadAction, SquadStatus> = {
  pause: 'paused',
  resume: 'active',
  kill: 'killed',
};

/** Throws `ConflictError` when the action makes no sense for the squad's current status. */
export function assertActionAllowed(squad: Squad, action: SquadAction): void {
  if (squad.status === 'killed') {
    throw new ConflictError(`squad ${squad.slug} is killed; it cannot be ${action}d`);
  }
  if (action === 'pause' && squad.status === 'paused') {
    throw new ConflictError(`squad ${squad.slug} is already paused`);
  }
  if (action === 'resume' && squad.status === 'active') {
    throw new ConflictError(`squad ${squad.slug} is already active`);
  }
}

function message(
  squad: Squad,
  decision: Decision,
  action: SquadControlMessage['action'],
  allocation: number | undefined,
): SquadControlMessage {
  return {
    action,
    squadId: squad.id,
    squad: squad.slug,
    ...(allocation === undefined ? {} : { allocation }),
    reason: decision.rationale,
    decisionId: decision.id,
    sentAt: nowIso(),
  };
}

async function deliver(
  ctx: AppContext,
  squad: Squad,
  msg: SquadControlMessage,
  failures: string[],
): Promise<void> {
  if (!squad.controlUrl) return;
  try {
    await ctx.control.send(squad.controlUrl, msg);
  } catch (error) {
    failures.push(`${squad.slug}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Carries out an approved decision: changes squad state, notifies control webhooks, and advances
 * the decision to `executed` (or `failed` with the delivery errors). The decision row must already
 * exist (invariant 6); this never throws for webhook failures.
 */
export async function executeDecision(ctx: AppContext, decision: Decision): Promise<Decision> {
  if (decision.status !== 'approved') {
    throw new ConflictError(`decision ${decision.id} is ${decision.status}, not approved`);
  }
  const failures: string[] = [];
  try {
    switch (decision.kind) {
      case 'pause':
      case 'resume':
      case 'kill': {
        if (!decision.squadId) throw new ConflictError(`decision ${decision.id} names no squad`);
        let squad = await squads.setStatus(ctx.db, decision.squadId, ACTION_STATUS[decision.kind]);
        let allocation: number | undefined;
        if (decision.kind === 'kill') {
          squad = await squads.setAllocation(ctx.db, squad.id, 0);
          allocation = 0;
        }
        await deliver(ctx, squad, message(squad, decision, decision.kind, allocation), failures);
        break;
      }
      case 'reallocate': {
        const { allocation } = AllocationPayloadSchema.parse(decision.payload);
        for (const [slug, share] of Object.entries(allocation)) {
          const squad = await squads.findBySlug(ctx.db, slug);
          if (!squad) {
            failures.push(`${slug}: squad no longer exists`);
            continue;
          }
          const updated = await squads.setAllocation(ctx.db, squad.id, share);
          await deliver(ctx, updated, message(updated, decision, 'reallocate', share), failures);
        }
        break;
      }
      case 'notify':
        break;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ err: error, decisionId: decision.id }, 'decision execution failed');
    const failed = await decisions.setStatus(ctx.db, decision.id, 'failed', { error: reason });
    await ctx.webhooks.emit('decision.made', { decision: failed });
    return failed;
  }
  const final =
    failures.length > 0
      ? await decisions.setStatus(ctx.db, decision.id, 'failed', {
          error: `control webhook delivery failed: ${failures.join('; ')}`,
        })
      : await decisions.setStatus(ctx.db, decision.id, 'executed');
  ctx.logger.info(
    { decisionId: final.id, kind: final.kind, squadId: final.squadId, status: final.status },
    'decision executed',
  );
  await ctx.webhooks.emit('decision.made', { decision: final });
  return final;
}
