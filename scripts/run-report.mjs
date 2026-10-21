#!/usr/bin/env node
// Per-variant report of a recorded run that keeps the unresolved sessions visible.
//
//   node scripts/run-report.mjs ./agon-out                 # newest run under the output directory
//   node scripts/run-report.mjs ./agon-out/run_abc123      # one run directory
//   node scripts/run-report.mjs ./agon-out --json
//
// Reads `run.json` and `sessions.jsonl` as the JSONL sink wrote them (see docs/run-termination.md,
// "Reading the per-variant counts"). For every variant it prints
//
//   <passed> passed / <completed> completed / <planned> planned
//
// a pass rate conditional on completion (passed ÷ completed, never passed ÷ planned), the interval
// the unresolved sessions leave open on the planned set, and the interruption count beside it, so
// a time cap that cut the slow sessions cannot be read as a clean rate. Needs only Node.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TIME_CAP_ERROR = 'run time cap reached';

function usage(message) {
  process.stderr.write(
    `${message}\nusage: node scripts/run-report.mjs <run dir | output dir> [--json]\n`,
  );
  process.exit(1);
}

/** A run directory as given, or the newest `run_*` directory under an output directory. */
export function resolveRunDir(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, 'run.json'))) return root;
  const runs = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('run_') && existsSync(join(root, name, 'run.json')))
        .map((name) => join(root, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (runs.length === 0) throw new Error(`no run.json in ${root} or in a run_* directory under it`);
  return runs[0];
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Sessions are assigned to variants round-robin over a seeded order (packages/engine, planSessions):
 * session i runs variantOrder[i % k]. The recorded sessions reveal the order; a residue nobody ran
 * is fixed only when a single variant is left for it. Returns the planned count per variant, or
 * null when the order cannot be recovered.
 */
export function plannedPerVariant(variants, planned, sessions) {
  const k = variants.length;
  const order = new Array(k).fill(undefined);
  for (const s of sessions) {
    if (typeof s.index !== 'number') continue;
    const seen = order[s.index % k];
    if (seen !== undefined && seen !== s.variant) return null;
    order[s.index % k] = s.variant;
  }
  const missing = variants.filter((v) => !order.includes(v));
  const open = order.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);
  if (open.length === 1 && missing.length === 1) order[open[0]] = missing[0];
  else if (open.length > 0) return null;
  const counts = Object.fromEntries(variants.map((v) => [v, 0]));
  for (let i = 0; i < planned; i++) counts[order[i % k]] += 1;
  return counts;
}

function isInterrupted(s) {
  return s.outcome === undefined && s.status === 'failed' && s.error === TIME_CAP_ERROR;
}

function tally(sessions, planned) {
  const passed = sessions.filter((s) => s.outcome === 'success').length;
  const completed = sessions.filter((s) => s.outcome !== undefined).length;
  const interrupted = sessions.filter(isInterrupted).length;
  const recorded = sessions.length;
  const notStarted = planned === null ? null : Math.max(0, planned - recorded);
  const unresolved = planned === null ? null : interrupted + notStarted;
  return {
    planned,
    recorded,
    passed,
    completed,
    didNotPass: completed - passed,
    errored: sessions.filter((s) => s.outcome === 'error').length,
    interrupted,
    notStarted,
    passRateOfCompleted: completed === 0 ? null : passed / completed,
    plannedSetRate:
      planned === null || planned === 0
        ? null
        : { low: passed / planned, high: (passed + unresolved) / planned },
  };
}

/** The report as data: one entry per variant plus `all`, and the run's termination. */
export function report(runDir) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const sessions = readJsonl(join(runDir, 'sessions.jsonl'));
  const variants = Array.isArray(run.variants) ? run.variants : [];
  const planned = run.counts?.planned ?? run.termination?.sessionsPlanned ?? sessions.length;
  const perVariantPlanned = plannedPerVariant(variants, planned, sessions);
  const byVariant = {};
  for (const v of variants) {
    byVariant[v] = tally(
      sessions.filter((s) => s.variant === v),
      perVariantPlanned === null ? null : perVariantPlanned[v],
    );
  }
  return {
    runId: run.id,
    runDir,
    experiment: run.config?.name ?? null,
    status: run.status,
    termination: run.termination ?? null,
    counts: run.counts ?? null,
    plannedPerVariantKnown: perVariantPlanned !== null,
    variants: byVariant,
    all: tally(sessions, planned),
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

function rateCell(t) {
  return t.passRateOfCompleted === null
    ? 'n/a (0 completed)'
    : `${pct(t.passRateOfCompleted)} of completed`;
}

function intervalCell(t) {
  if (t.plannedSetRate === null) return 'unknown';
  const { low, high } = t.plannedSetRate;
  return low === high ? `${pct(low)} (all resolved)` : `${pct(low)}–${pct(high)} (open)`;
}

function countsCell(t) {
  const planned = t.planned === null ? '?' : String(t.planned);
  return `${t.passed} passed / ${t.completed} completed / ${planned} planned`;
}

function table(headers, rows) {
  const cells = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => String(r[i] ?? '').length)));
  return cells
    .map((r) =>
      r
        .map((c, i) => String(c).padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatReport(r) {
  const t = r.termination;
  const head =
    t === null
      ? `${r.runId} ${r.status}`
      : `${r.runId} ${r.status}: ${t.kind} after ${(t.elapsedMs / 1000).toFixed(1)}s (cap ${t.capMs} ms) · ${t.sessionsExecuted}/${t.sessionsPlanned} sessions reached an outcome`;
  const rows = Object.entries(r.variants).map(([v, x]) => [
    v,
    countsCell(x),
    rateCell(x),
    intervalCell(x),
    x.interrupted,
    x.notStarted ?? '?',
    x.didNotPass,
  ]);
  rows.push([
    'all',
    countsCell(r.all),
    rateCell(r.all),
    intervalCell(r.all),
    r.all.interrupted,
    r.all.notStarted ?? '?',
    r.all.didNotPass,
  ]);
  const lines = [
    head,
    '',
    table(
      [
        'variant',
        'sessions',
        'pass rate',
        'planned-set rate',
        'interrupted',
        'not started',
        'did not pass',
      ],
      rows,
    ),
    '',
    '  pass rate is conditional on completion: passed ÷ completed. It says nothing about the sessions that',
    '  never reached an outcome.',
    '  planned-set rate is the interval the unresolved sessions leave open: passed ÷ planned at the low end,',
    '  (passed + interrupted + not started) ÷ planned at the high end. Only a run with nothing unresolved',
    '  has a single planned-set rate.',
    '  interrupted: stopped by the run time cap with no outcome (status failed, error "run time cap reached").',
    '  not started: planned but never begun when the run ended. did not pass: completed with an outcome other',
    '  than success (gave_up, max_steps, budget_exceeded, stalled, error).',
  ];
  if (!r.plannedPerVariantKnown) {
    lines.push(
      '',
      '  planned per variant could not be recovered from the recorded sessions (too few ran to reveal the',
      '  seeded variant order); the planned-set interval is shown for the run as a whole only.',
    );
  }
  return lines.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (dirs.length !== 1) usage('expected one run directory or output directory');
  let runDir;
  try {
    runDir = resolveRunDir(dirs[0]);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const r = report(runDir);
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${formatReport(r)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2));
}
