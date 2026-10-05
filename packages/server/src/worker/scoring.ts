import { squads, type Db } from '@agon/db';
import type { Result, Run, Session, Squad } from '@agon/spec';
import type { Logger } from 'pino';
import { bestComparison, creditedSquads, isLoss, isWin } from '../squads/credit.js';

export interface ScoreUpdate {
  squad: Squad;
  variants: string[];
  win: boolean;
  loss: boolean;
  lift: number | undefined;
  costUsd: number;
}

/**
 * Credits every squad named by the run's config with the run: a win when the result ships one of
 * its variants, a loss when it kills or ships somebody else's. Lift is the squad's best variant on
 * the primary metric; cost is what its variants' sessions spent.
 */
export async function updateSquadScores(
  db: Db,
  run: Run,
  result: Result,
  sessions: readonly Session[],
  logger: Logger,
): Promise<ScoreUpdate[]> {
  const updates: ScoreUpdate[] = [];
  for (const [slug, variants] of creditedSquads(run.config)) {
    if (!variants.some((v) => run.variants.includes(v))) continue;
    const squad = await squads.findBySlug(db, slug);
    if (!squad) {
      logger.warn({ runId: run.id, squad: slug }, 'config credits an unknown squad; not scored');
      continue;
    }
    const win = isWin(result, variants);
    const loss = isLoss(result, variants);
    const lift = bestComparison(result, variants)?.lift;
    const costUsd = sessions
      .filter((s) => variants.includes(s.variant))
      .reduce((sum, s) => sum + s.costUsd, 0);
    const runs = squad.score.runs + 1;
    const wins = squad.score.wins + (win ? 1 : 0);
    const meanLift =
      lift === undefined
        ? squad.score.meanLift
        : (squad.score.meanLift * squad.score.runs + lift) / runs;
    const updated = await squads.updateScore(db, squad.id, {
      runs,
      wins,
      winRate: runs === 0 ? 0 : wins / runs,
      meanLift,
      costUsd: squad.score.costUsd + costUsd,
    });
    logger.info(
      { runId: run.id, squad: slug, win, loss, lift, costUsd, score: updated.score },
      'squad score updated',
    );
    updates.push({ squad: updated, variants, win, loss, lift, costUsd });
  }
  return updates;
}
