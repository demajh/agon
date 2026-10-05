import { environments, results, runs, type Db } from '@agon/db';
import type { Result, Run } from '@agon/spec';
import { bestComparison, creditedSquads } from './credit.js';

export interface SquadRunResult {
  run: Run;
  result: Result;
  /** The squad's best variant on the primary metric, when it was compared. */
  pBest: number | undefined;
  lift: number | undefined;
}

/**
 * The most recent completed runs crediting a squad, newest first, with their results. Walks every
 * environment's runs: fine for the deployments this release targets, to be replaced by a query
 * when runs can be indexed by squad.
 */
export async function squadResultHistory(
  db: Db,
  slug: string,
  limit: number,
): Promise<SquadRunResult[]> {
  const candidates: Run[] = [];
  let envCursor: string | undefined;
  do {
    const page = await environments.list(db, { limit: 200, cursor: envCursor });
    for (const env of page.items) {
      let taken = 0;
      let runCursor: string | undefined;
      do {
        const runPage = await runs.listByEnvironment(db, env.id, {
          status: 'completed',
          limit: 100,
          cursor: runCursor,
        });
        for (const run of runPage.items) {
          if (!run.resultId) continue;
          const variants = creditedSquads(run.config).get(slug);
          if (!variants) continue;
          candidates.push(run);
          if (++taken >= limit) break;
        }
        runCursor = taken >= limit ? undefined : runPage.nextCursor;
      } while (runCursor);
    }
    envCursor = page.nextCursor;
  } while (envCursor);

  candidates.sort((a, b) => {
    const ta = Date.parse(a.finishedAt ?? a.createdAt);
    const tb = Date.parse(b.finishedAt ?? b.createdAt);
    return tb - ta || (a.id < b.id ? 1 : -1);
  });

  const out: SquadRunResult[] = [];
  for (const run of candidates.slice(0, limit)) {
    const result = await results.findByRun(db, run.id);
    if (!result) continue;
    const variants = creditedSquads(run.config).get(slug) ?? [];
    const best = bestComparison(result, variants);
    out.push({ run, result, pBest: best?.pBest, lift: best?.lift });
  }
  return out;
}

/** Mean P(best) of the squad's last `n` results; undefined without any. */
export async function rollingPBest(db: Db, slug: string, n: number): Promise<number | undefined> {
  const history = await squadResultHistory(db, slug, n);
  const values = history.map((h) => h.pBest).filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
