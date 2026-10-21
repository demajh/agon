#!/usr/bin/env node
// Per-planned-session timeline of a recorded run: variant and case, whether the session started,
// its start offset from the run's clock, elapsed time until completion or interruption, and an
// outcome status (completed, failed, interrupted, never started, no record). Per-variant totals
// and duration summaries derive from those rows with the planned and started denominators kept
// visible, so a variant whose cases ran slow reads differently from one that was scheduled late
// when the time cap cut the run. See docs/session-timeline.md.
//
//   node scripts/session-timeline.mjs <runDir | outDir> [--json] [--config-dir <dir>]
//
// Reads `run.json` and `sessions.jsonl` as `agon run` wrote them. Sessions that never started
// have no row in `sessions.jsonl`; their variant and case come from replaying the plan, which is
// a pure function of the run record (config snapshot, seed, size, variants, run id). Needs the
// workspace built (`pnpm build`) for the replay; without it the never-started rows carry no
// variant or case and the per-variant table says so.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RunSchema, SessionSchema } from '@agon/spec';

const ENGINE = new URL('../packages/engine/dist/index.js', import.meta.url);

function usage(message) {
  process.stderr.write(
    `${message ? `${message}\n` : ''}usage: node scripts/session-timeline.mjs <runDir | outDir> [--json] [--config-dir <dir>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, configDir: process.cwd(), dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--config-dir') {
      const value = argv[++i];
      if (value === undefined) usage('--config-dir needs a directory');
      options.configDir = resolve(value);
    } else if (arg.startsWith('-')) usage(`unknown flag ${arg}`);
    else if (options.dir === undefined) options.dir = arg;
    else usage('one run directory at a time');
  }
  if (options.dir === undefined) usage();
  return options;
}

/** A run directory, or an output directory whose newest run is used (as `agon trace` does). */
function resolveRunDir(input) {
  const dir = resolve(input);
  if (existsSync(join(dir, 'run.json'))) return dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) usage(`${dir} is not a directory`);
  const runs = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => existsSync(join(p, 'run.json')))
    .map((p) => ({ p, createdAt: readRun(p).createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (runs.length === 0) usage(`no runs found under ${dir} (expected <dir>/<runId>/run.json)`);
  return runs[0].p;
}

function readRun(runDir) {
  return RunSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
}

function readSessions(runDir) {
  const path = join(runDir, 'sessions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => SessionSchema.parse(JSON.parse(line)));
}

/**
 * Replays the plan from the run record. Returns `{ plans }` or `{ error }`: the engine may not be
 * built, a persona file may be unreachable from `configDir`, or (never seen, but checked) the
 * replayed ids may disagree with the recorded rows.
 */
async function replayPlan(run, sessions, configDir) {
  let engine;
  try {
    engine = await import(ENGINE);
  } catch (error) {
    return { error: `engine not built (${error.message}); run \`pnpm build\`` };
  }
  try {
    const personas = engine.resolvePersonas(run.config, { cwd: configDir });
    const plans = engine.planSessions(run.config, personas, {
      runId: run.id,
      variants: run.variants,
      seed: run.seed,
      size: run.counts.planned,
      defaultModel: run.config.defaults.model,
    });
    for (const s of sessions) {
      const plan = plans[s.index];
      const same =
        plan !== undefined &&
        plan.sessionId === s.id &&
        plan.variant === s.variant &&
        plan.scenario.id === s.scenarioId &&
        plan.persona.personaId === s.persona.personaId;
      if (!same) {
        return {
          error: `replayed plan disagrees with the recorded row at index ${s.index} (${plan ? `${plan.sessionId} ${plan.variant} ${plan.scenario.id}` : 'none'} vs ${s.id} ${s.variant} ${s.scenarioId})`,
        };
      }
    }
    return { plans };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function ms(a, b) {
  return a === undefined || b === undefined ? null : Math.max(0, Date.parse(b) - Date.parse(a));
}

/** Nearest-rank quantile of a sorted array; the same rule `@agon/engine` uses for stall gaps. */
function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? null
    : {
        n: sorted.length,
        median: quantile(sorted, 0.5),
        p90: quantile(sorted, 0.9),
        max: sorted.at(-1),
      };
}

function rowFor(run, index, session, plan, dispatched) {
  const base = {
    index,
    sessionId: plan?.sessionId ?? session?.id ?? null,
    variant: plan?.variant ?? session?.variant ?? null,
    case: plan?.scenario.id ?? session?.scenarioId ?? null,
    persona: plan?.persona.personaId ?? session?.persona.personaId ?? null,
  };
  if (session === undefined) {
    // The orchestrator dispatches sessions in index order and every dispatched session yields a
    // row or a crash, so an index below the dispatched count without a row was dispatched and
    // crashed before its record was written; one at or above it never started.
    const status = index < dispatched ? 'no_record' : 'never_started';
    return {
      ...base,
      status,
      started: status === 'no_record',
      startOffsetMs: null,
      elapsedMs: null,
      elapsedKind: null,
      steps: null,
      outcome: null,
      reason: null,
    };
  }
  const interrupted = session.status === 'failed' && session.outcome === undefined;
  const status = interrupted ? 'interrupted' : session.status === 'failed' ? 'failed' : 'completed';
  return {
    ...base,
    status,
    started: true,
    startOffsetMs: ms(run.startedAt, session.startedAt),
    elapsedMs: ms(session.startedAt, session.finishedAt),
    elapsedKind: interrupted ? 'observed' : 'runtime',
    steps: session.steps,
    outcome: session.outcome ?? null,
    reason: session.outcomeReason ?? session.error ?? null,
  };
}

function variantSummary(variant, rows) {
  const by = (status) => rows.filter((r) => r.status === status);
  const started = rows.filter((r) => r.started && r.startOffsetMs !== null);
  const runtimes = rows.filter((r) => r.elapsedKind === 'runtime').map((r) => r.elapsedMs);
  const observed = rows.filter((r) => r.elapsedKind === 'observed').map((r) => r.elapsedMs);
  const offsets = started.map((r) => r.startOffsetMs).sort((a, b) => a - b);
  return {
    variant,
    planned: rows.length,
    started: rows.filter((r) => r.started).length,
    completed: by('completed').length,
    failed: by('failed').length,
    interrupted: by('interrupted').length,
    neverStarted: by('never_started').length,
    noRecord: by('no_record').length,
    runtimeMs: summary(runtimes),
    observedMs: summary(observed),
    startOffsetMs:
      offsets.length === 0
        ? null
        : {
            n: offsets.length,
            first: offsets[0],
            median: quantile(offsets, 0.5),
            last: offsets.at(-1),
          },
  };
}

function build(run, sessions, plans) {
  const byIndex = new Map(sessions.map((s) => [s.index, s]));
  const dispatched = run.counts.completed + run.counts.failed + run.counts.interrupted;
  const rows = [];
  for (let i = 0; i < run.counts.planned; i++) {
    rows.push(rowFor(run, i, byIndex.get(i), plans?.[i], dispatched));
  }
  const variants = run.variants.map((v) =>
    variantSummary(
      v,
      rows.filter((r) => r.variant === v),
    ),
  );
  const unattributed = rows.filter((r) => r.variant === null);
  if (unattributed.length > 0) variants.push(variantSummary(null, unattributed));
  const count = (status) => rows.filter((r) => r.status === status).length;
  return {
    counts: {
      planned: rows.length,
      started: rows.filter((r) => r.started).length,
      completed: count('completed'),
      failed: count('failed'),
      interrupted: count('interrupted'),
      neverStarted: count('never_started'),
      noRecord: count('no_record'),
    },
    variants,
    sessions: rows,
  };
}

const seconds = (value) =>
  value === null || value === undefined ? '—' : `${(value / 1000).toFixed(1)}s`;
const STATUS_LABEL = {
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
  never_started: 'never started',
  no_record: 'no record',
};

function table(headers, rows) {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function render(run, runDir, report, plan) {
  const t = run.termination;
  const c = report.counts;
  const lines = [];
  const head = t
    ? `${t.kind} after ${seconds(t.elapsedMs)} (cap ${t.capMs} ms)`
    : `${run.status} (no termination recorded)`;
  lines.push(
    `${run.id} ${run.config.name}: ${head} · ${c.planned} planned, ${c.started} started, ${c.completed} completed, ${c.failed} failed, ${c.interrupted} interrupted, ${c.neverStarted} never started${c.noRecord ? `, ${c.noRecord} without a record` : ''}`,
  );
  if (t?.lastCompletedStage === 'setup') lines.push('  dry run: planned only, nothing executed');
  if (t?.kind === 'time_cap_reached' && run.startedAt) {
    lines.push(
      `  clock started ${run.startedAt}; the cap fired at ${new Date(Date.parse(run.startedAt) + t.capMs).toISOString()}`,
    );
  }
  lines.push(
    plan.plans
      ? `  plan: replayed from run.json (seed ${run.seed}, ${run.counts.planned} sessions); session ids match the recorded rows`
      : `  plan: not replayed (${plan.error}); never-started rows carry no variant or case`,
  );
  lines.push('');
  const q = (s) => (s === null ? '—' : `${seconds(s.median)}/${seconds(s.p90)}/${seconds(s.max)}`);
  const o = (s) =>
    s === null ? '—' : `${seconds(s.first)}/${seconds(s.median)}/${seconds(s.last)}`;
  lines.push(
    table(
      [
        'variant',
        'planned',
        'started',
        'completed',
        'failed',
        'interrupted',
        'never started',
        'no record',
        'runtime med/p90/max',
        'observed med/p90/max',
        'start offset first/med/last',
      ],
      report.variants.map((v) => [
        v.variant ?? '(unattributed)',
        v.planned,
        v.started,
        v.completed,
        v.failed,
        v.interrupted,
        v.neverStarted,
        v.noRecord,
        q(v.runtimeMs),
        q(v.observedMs),
        o(v.startOffsetMs),
      ]),
    ),
  );
  lines.push('');
  lines.push(
    table(
      ['#', 'session', 'variant', 'case', 'status', 'start', 'elapsed', 'steps', 'outcome'],
      report.sessions.map((r) => [
        r.index,
        r.sessionId ?? '—',
        r.variant ?? '—',
        r.case ?? '—',
        STATUS_LABEL[r.status],
        seconds(r.startOffsetMs),
        r.elapsedMs === null
          ? '—'
          : `${seconds(r.elapsedMs)}${r.elapsedKind === 'observed' ? ' so far' : ''}`,
        r.steps ?? '—',
        r.outcome ?? (r.status === 'interrupted' ? 'none (interrupted)' : '—'),
      ]),
    ),
  );
  lines.push('');
  lines.push(
    '  runtime: completed and failed sessions, start to outcome. observed: interrupted sessions, start to the step boundary where the run stopped them; not a runtime. start offset: from the run clock (on a server, the moment the run was queued).',
  );
  lines.push(`  source: ${runDir}`);
  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const runDir = resolveRunDir(options.dir);
const run = readRun(runDir);
const sessions = readSessions(runDir);
const plan = await replayPlan(run, sessions, options.configDir);
const report = build(run, sessions, plan.plans);

if (options.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: run.id,
        runDir,
        name: run.config.name,
        status: run.status,
        startedAt: run.startedAt ?? null,
        termination: run.termination ?? null,
        plan: plan.plans ? { replayed: true } : { replayed: false, reason: plan.error },
        ...report,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${render(run, runDir, report, plan)}\n`);
}
