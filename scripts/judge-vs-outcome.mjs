#!/usr/bin/env node
// How often the anchored outcome check fails a session the judge rated high.
//
//   node scripts/judge-vs-outcome.mjs ./agon-out                    # every run_* under an output directory
//   node scripts/judge-vs-outcome.mjs ./agon-out/run_abc123 ./other # run directories and output directories mix
//   node scripts/judge-vs-outcome.mjs ./agon-out --min-satisfaction 4
//   node scripts/judge-vs-outcome.mjs ./agon-out --json
//
// Reads `run.json` and `sessions.jsonl` as the JSONL sink wrote them (see docs/judge-vs-outcome.md).
// A session counts when three things hold: its scenario's success criterion is anchored (`event`,
// `url`, `text` or `check`, so the outcome was not decided by the judge), it reached an outcome, and
// it carries a judgement. "Rated high" is the judge's own `success: true`, optionally with a
// satisfaction floor. The disagreement count is the rated-high sessions whose outcome is anything
// other than `success`. Runs whose judge was the offline fake (`fake/...`) are listed and left out
// of the total: a scripted judge measures nothing. Needs only Node.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ANCHORED = new Set(['event', 'url', 'text', 'check']);

/** Below this many rated-high sessions the output says the sample is small. */
export const SMALL_SAMPLE = 30;

function usage(message) {
  process.stderr.write(
    `${message}\nusage: node scripts/judge-vs-outcome.mjs <run dir | output dir>... [--min-satisfaction <1-5>] [--json]\n`,
  );
  process.exit(1);
}

/** A run directory as given, or every `run_*` directory under an output directory, by name. */
export function resolveRunDirs(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, 'run.json'))) return [root];
  const runs = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('run_') && existsSync(join(root, name, 'run.json')))
        .sort()
        .map((name) => join(root, name))
    : [];
  if (runs.length === 0) throw new Error(`no run.json in ${root} or in a run_* directory under it`);
  return runs;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** The 95% Wilson score interval for k of n, or null over an empty set. */
export function wilson(k, n) {
  if (n === 0) return null;
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function emptyCounts() {
  return {
    sessions: 0,
    judgeDecided: 0,
    noOutcome: 0,
    anchoredOutcome: 0,
    notJudged: 0,
    judged: 0,
    judgeHigh: 0,
    judgeHighOutcomeFailed: 0,
    judgeLow: 0,
    judgeLowOutcomePassed: 0,
  };
}

function add(into, from) {
  for (const key of Object.keys(into)) into[key] += from[key];
  return into;
}

/** One run's counts. `minSatisfaction` (1-5) narrows "rated high"; 0 leaves it at `success: true`. */
export function countRun(runDir, minSatisfaction = 0) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const sessions = readJsonl(join(runDir, 'sessions.jsonl'));
  const successType = new Map(
    (run.config?.scenarios ?? []).map((scenario) => [scenario.id, scenario.success?.type]),
  );
  const judgeModel = run.config?.defaults?.judgeModel ?? run.config?.defaults?.model ?? null;
  const counts = emptyCounts();
  const disagreements = [];
  for (const s of sessions) {
    counts.sessions += 1;
    if (!ANCHORED.has(successType.get(s.scenarioId))) {
      counts.judgeDecided += 1;
      continue;
    }
    if (s.outcome === undefined) {
      counts.noOutcome += 1;
      continue;
    }
    counts.anchoredOutcome += 1;
    if (s.judgement === undefined) {
      counts.notJudged += 1;
      continue;
    }
    counts.judged += 1;
    const high = s.judgement.success === true && s.judgement.satisfaction >= minSatisfaction;
    if (high) {
      counts.judgeHigh += 1;
      if (s.outcome !== 'success') {
        counts.judgeHighOutcomeFailed += 1;
        disagreements.push({
          sessionId: s.id,
          outcome: s.outcome,
          outcomeReason: s.outcomeReason ?? null,
          satisfaction: s.judgement.satisfaction,
          confidence: s.judgement.confidence,
          summary: s.judgement.summary,
        });
      }
    } else {
      counts.judgeLow += 1;
      if (s.outcome === 'success') counts.judgeLowOutcomePassed += 1;
    }
  }
  return {
    runId: run.id,
    runDir,
    experiment: run.config?.name ?? null,
    date: typeof run.startedAt === 'string' ? run.startedAt.slice(0, 10) : null,
    judgeModel,
    scriptedJudge: typeof judgeModel === 'string' && judgeModel.startsWith('fake/'),
    counts,
    disagreements,
  };
}

/** The report as data: one entry per run, and the total over the runs whose judge was a model. */
export function report(dirs, minSatisfaction = 0) {
  const seen = new Set();
  const runs = [];
  for (const dir of dirs) {
    for (const runDir of resolveRunDirs(dir)) {
      if (seen.has(runDir)) continue;
      seen.add(runDir);
      runs.push(countRun(runDir, minSatisfaction));
    }
  }
  const counted = runs.filter((r) => !r.scriptedJudge);
  const total = counted.reduce((sum, r) => add(sum, r.counts), emptyCounts());
  const dates = counted
    .map((r) => r.date)
    .filter((d) => d !== null)
    .sort();
  const n = total.judgeHigh;
  const k = total.judgeHighOutcomeFailed;
  return {
    high:
      minSatisfaction > 0
        ? `judge success and satisfaction >= ${minSatisfaction}`
        : 'judge success',
    runsRead: runs.length,
    runsCounted: counted.length,
    runsExcludedScriptedJudge: runs.length - counted.length,
    firstRunDate: dates[0] ?? null,
    lastRunDate: dates.at(-1) ?? null,
    total,
    disagreementRate: n === 0 ? null : k / n,
    interval95: wilson(k, n),
    sample: n === 0 ? 'none' : n < SMALL_SAMPLE ? 'small' : 'ok',
    runs,
  };
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)));
  return rows
    .map((row) =>
      row
        .map((cell, col) => String(cell).padEnd(widths[col]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function countCells(c) {
  return [c.sessions, c.anchoredOutcome, c.judged, c.judgeHigh, c.judgeHighOutcomeFailed];
}

export function render(r) {
  const lines = [
    `judge vs anchored outcome · ${r.runsRead} run(s) read, ${r.runsCounted} counted · rated high = ${r.high}`,
    '',
    table([
      [
        'run',
        'date',
        'judge model',
        'sessions',
        'anchored outcome',
        'judged',
        'rated high',
        'of those, outcome failed',
        'counted',
      ],
      ...r.runs.map((run) => [
        run.runId,
        run.date ?? 'unknown',
        run.judgeModel ?? 'unknown',
        ...countCells(run.counts),
        run.scriptedJudge ? 'no (scripted judge)' : 'yes',
      ]),
      ['total counted', '', '', ...countCells(r.total), ''],
    ]),
    '',
  ];
  const n = r.total.judgeHigh;
  const k = r.total.judgeHighOutcomeFailed;
  if (r.sample === 'none') {
    lines.push(
      `outcome check failed on rated-high work: undefined (0 of 0). No sample: no counted session carries a judgement beside an anchored outcome.`,
    );
  } else {
    const span =
      r.firstRunDate === r.lastRunDate ? r.firstRunDate : `${r.firstRunDate} to ${r.lastRunDate}`;
    lines.push(
      `outcome check failed on rated-high work: ${k} of ${n} (${pct(r.disagreementRate)}, 95% Wilson interval ${pct(r.interval95.low)}–${pct(r.interval95.high)}), runs dated ${span}`,
    );
    if (r.sample === 'small')
      lines.push(
        `Small sample: ${n} rated-high session(s), under ${SMALL_SAMPLE}. Quote the counts, not the rate.`,
      );
    lines.push(
      `the other direction: ${r.total.judgeLowOutcomePassed} of ${r.total.judgeLow} session(s) the judge did not rate high passed the outcome check`,
    );
  }
  const skipped = [];
  if (r.total.judgeDecided > 0)
    skipped.push(`${r.total.judgeDecided} in scenarios where the judge decides the outcome`);
  if (r.total.noOutcome > 0) skipped.push(`${r.total.noOutcome} without an outcome`);
  if (r.total.notJudged > 0) skipped.push(`${r.total.notJudged} without a judgement`);
  if (skipped.length > 0) lines.push(`counted sessions left out: ${skipped.join(', ')}`);
  for (const run of r.runs) {
    if (run.scriptedJudge) continue;
    for (const d of run.disagreements)
      lines.push(
        `  ${d.sessionId}: outcome ${d.outcome}${d.outcomeReason ? ` (${d.outcomeReason})` : ''}; judge satisfaction ${d.satisfaction}/5, confidence ${d.confidence}: ${d.summary}`,
      );
  }
  return lines.join('\n');
}

function main(argv) {
  const dirs = [];
  let json = false;
  let minSatisfaction = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--min-satisfaction') {
      minSatisfaction = Number(argv[++i]);
      if (!Number.isInteger(minSatisfaction) || minSatisfaction < 1 || minSatisfaction > 5)
        usage('--min-satisfaction takes an integer from 1 to 5');
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else dirs.push(arg);
  }
  if (dirs.length === 0) usage('missing run or output directory');
  let result;
  try {
    result = report(dirs, minSatisfaction);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${json ? JSON.stringify(result, null, 2) : render(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
