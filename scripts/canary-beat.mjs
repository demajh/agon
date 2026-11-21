#!/usr/bin/env node
// A heartbeat-only sibling for a run, and the reader that uses it. See docs/host-canary.md.
//
//   node scripts/canary-beat.mjs beat --out beats.jsonl [--interval-ms 1000] [--host <label>] [-- <command...>]
//   node scripts/canary-beat.mjs read <runDir | outDir> --beats beats.jsonl [--quiet-ms 5000] [--late-ms <n>] [--json]
//
// `beat` does nothing but append one line per interval to a file, fsynced, from its own process:
// no model call, no adapter, no session. With a command after `--` it runs that command beside
// itself, stops when it exits and exits with its code; without one it beats until it is
// signalled. `read` takes a recorded run and the beats, finds every window in which no session of
// the run wrote a timestamp, and says for each whether the canary on that host kept beating
// (`writers_quiet`: the host kept time, the cause is in the writers' work or in something they
// share other than the host), went silent with them (`host_stall`), did both (`mixed`) or was not
// there (`unobserved`); a run that never finished is `command_exited` when the canary recorded
// its command's exit. Needs only Node.
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { constants, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `usage:
  node scripts/canary-beat.mjs beat --out <beats.jsonl> [--interval-ms 1000] [--host <label>] [-- <command...>]
  node scripts/canary-beat.mjs read <runDir | outDir> --beats <beats.jsonl> [--quiet-ms 5000] [--late-ms <n>] [--json]
`;

function usage(message) {
  process.stderr.write(`${message ? `${message}\n` : ''}${USAGE}`);
  process.exit(2);
}

function positiveInt(flag, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) usage(`${flag} needs a positive integer`);
  return n;
}

// ---------------------------------------------------------------------------
// beat
// ---------------------------------------------------------------------------

function parseBeatArgs(argv) {
  const options = { out: undefined, intervalMs: 1000, host: hostname(), command: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.command = argv.slice(i + 1);
      break;
    } else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--interval-ms') options.intervalMs = positiveInt(arg, argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else usage(`unknown argument ${arg}`);
  }
  if (options.out === undefined) usage('beat needs --out <file>');
  if (!options.host) usage('--host needs a label');
  return options;
}

function beat(argv) {
  const options = parseBeatArgs(argv);
  const path = resolve(options.out);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  let writeFailed = false;
  // One line per write, fsynced, so a beat that was written survives the host going down. A
  // failed write (a full disk is a host condition too) is reported once and leaves a gap.
  const write = (row) => {
    try {
      writeSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
      writeFailed = false;
    } catch (error) {
      if (!writeFailed) process.stderr.write(`canary: cannot write ${path}: ${error.message}\n`);
      writeFailed = true;
    }
  };

  const child =
    options.command.length === 0
      ? undefined
      : spawn(options.command[0], options.command.slice(1), { stdio: 'inherit' });

  const startMono = performance.now();
  write({
    kind: 'start',
    host: options.host,
    pid: process.pid,
    intervalMs: options.intervalMs,
    t: new Date().toISOString(),
    ...(child === undefined ? {} : { command: options.command, childPid: child.pid }),
  });

  // Beats sit on a fixed schedule of slots. A beat that fires late says how late; the slots it
  // missed are skipped, never made up, so a stall stays a gap in the file.
  let seq = 0;
  let slot = 0;
  let timer;
  const tick = () => {
    const mono = performance.now() - startMono;
    write({
      kind: 'beat',
      seq: seq++,
      t: new Date().toISOString(),
      monoMs: Math.round(mono),
      lateMs: Math.round(mono - slot * options.intervalMs),
    });
    // A timer may fire a millisecond early; the next slot is always a later one.
    slot = Math.max(slot, Math.floor(mono / options.intervalMs)) + 1;
    timer = setTimeout(
      tick,
      Math.max(0, slot * options.intervalMs - (performance.now() - startMono)),
    );
  };
  tick();

  let ended = false;
  const end = (row, code) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    write({ kind: 'end', t: new Date().toISOString(), beats: seq, ...row });
    closeSync(fd);
    process.exit(code);
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      // With a command, pass the signal on and keep beating until the command is gone.
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      } else end({ reason: 'signal', signal }, 0);
    });
  }
  if (child !== undefined) {
    child.on('error', (error) => {
      process.stderr.write(`canary: cannot start ${options.command[0]}: ${error.message}\n`);
      end({ reason: 'command_failed_to_start', error: error.message }, 127);
    });
    child.on('exit', (code, signal) => {
      if (signal !== null)
        end({ reason: 'command_exit', signal }, 128 + (constants.signals[signal] ?? 0));
      else end({ reason: 'command_exit', exitCode: code }, code ?? 1);
    });
  }
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A process killed mid-write leaves a torn last line; what came before it still counts.
    }
  }
  return rows;
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

function ms(value) {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Every timestamp a session of the run wrote, per session: its start and finish (`sessions.jsonl`,
 * written when the session ends), the start and end of each step (`steps.jsonl`) and each event
 * (`events.jsonl`). A session with steps and no row in `sessions.jsonl` never finished on record.
 */
export function writerActivity({ sessions, steps, events }) {
  const writers = new Map();
  const writer = (id) => {
    if (!writers.has(id)) writers.set(id, { id, points: [], finished: false });
    return writers.get(id);
  };
  const add = (id, t) => {
    if (typeof id === 'string' && t !== undefined) writer(id).points.push(t);
  };
  for (const s of sessions) {
    add(s.id, ms(s.startedAt));
    add(s.id, ms(s.finishedAt));
    if (typeof s.id === 'string' && ms(s.finishedAt) !== undefined) writer(s.id).finished = true;
  }
  for (const step of steps) {
    const started = ms(step.startedAt);
    add(step.sessionId, started);
    if (started !== undefined && typeof step.durationMs === 'number')
      add(step.sessionId, started + step.durationMs);
  }
  for (const event of events) add(event.sessionId, ms(event.timestamp));
  return [...writers.values()]
    .filter((w) => w.points.length > 0)
    .map((w) => {
      w.points.sort((a, b) => a - b);
      return { ...w, first: w.points[0], last: w.points[w.points.length - 1] };
    });
}

/** The canary's record: its start line, its beats in time order, and its end line if it wrote one. */
export function parseBeats(rows) {
  const start = rows.find((r) => r.kind === 'start');
  const end = rows.findLast((r) => r.kind === 'end');
  const beats = rows
    .filter((r) => r.kind === 'beat' && ms(r.t) !== undefined)
    .map((r) => ({ t: ms(r.t), monoMs: typeof r.monoMs === 'number' ? r.monoMs : undefined }))
    .sort((a, b) => a.t - b.t);
  return {
    host: start?.host,
    pid: start?.pid,
    childPid: start?.childPid,
    intervalMs: typeof start?.intervalMs === 'number' ? start.intervalMs : undefined,
    beats,
    end: end === undefined ? undefined : { ...end, t: ms(end.t) },
  };
}

/**
 * What the canary did across the window [from, to]. It covers the window when it beat at or
 * before `from` and at or after `to`; its silence is the part of the window that falls inside a
 * pause between two consecutive beats longer than `lateMs`.
 */
export function judgeWindow(canary, from, to, lateMs) {
  const { beats } = canary;
  let before = -1;
  for (let i = 0; i < beats.length && beats[i].t <= from; i++) before = i;
  const after = beats.findIndex((b) => b.t >= to);
  const inside = beats.filter((b) => b.t > from && b.t < to).length;
  if (before === -1 || after === -1) {
    return { verdict: 'unobserved', beats: inside, silentMs: null, pauses: [] };
  }
  const pauses = [];
  let silentMs = 0;
  for (let i = before; i < after; i++) {
    const a = beats[i];
    const b = beats[i + 1];
    if (b.t - a.t <= lateMs) continue;
    const overlap = Math.min(b.t, to) - Math.max(a.t, from);
    if (overlap <= 0) continue;
    silentMs += overlap;
    pauses.push({
      from: new Date(a.t).toISOString(),
      to: new Date(b.t).toISOString(),
      wallMs: b.t - a.t,
      // The monotonic clock beside the wall clock: far less monotonic than wall time elapsed
      // means the clock itself stopped (a suspended machine), not that the process was kept waiting.
      monoMs: a.monoMs !== undefined && b.monoMs !== undefined ? b.monoMs - a.monoMs : null,
    });
  }
  const share = silentMs / (to - from);
  const verdict = silentMs === 0 ? 'writers_quiet' : share >= 0.5 ? 'host_stall' : 'mixed';
  return { verdict, beats: inside, silentMs, pauses };
}

/**
 * Quiet windows of a run: stretches longer than `quietMs` in which no session wrote a timestamp,
 * each judged against the canary. The run's span is its `startedAt` to its `finishedAt`; a run
 * with no `finishedAt` (killed, or its host went down) is open-ended, and its last window runs
 * from the last thing any session wrote to the last thing the canary wrote.
 */
export function quietWindows({ run, sessions, steps, events, canary, quietMs, lateMs }) {
  const writers = writerActivity({ sessions, steps, events });
  const points = writers.flatMap((w) => w.points);
  const runStart = ms(run.startedAt) ?? ms(run.createdAt);
  const runEnd = ms(run.finishedAt);
  if (runStart !== undefined) points.push(runStart);
  if (runEnd !== undefined) points.push(runEnd);
  points.sort((a, b) => a - b);

  const inFlight = (from, to) =>
    writers.filter((w) => w.first <= from && (w.last >= to || !w.finished)).map((w) => w.id);
  const windows = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (to - from <= quietMs) continue;
    windows.push({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      quietMs: to - from,
      open: false,
      inFlight: inFlight(from, to),
      ...judgeWindow(canary, from, to, lateMs),
    });
  }

  if (runEnd === undefined && points.length > 0) {
    const from = points[points.length - 1];
    const lastBeat = canary.beats.length > 0 ? canary.beats[canary.beats.length - 1].t : undefined;
    const canaryLast = Math.max(lastBeat ?? -Infinity, canary.end?.t ?? -Infinity);
    const unfinished = writers.filter((w) => !w.finished).map((w) => w.id);
    const tail = { from: new Date(from).toISOString(), open: true, inFlight: unfinished };
    if (canaryLast - from > quietMs) {
      // The canary outlived everything the writers wrote: the host was up after they went quiet.
      windows.push({
        ...tail,
        to: new Date(canaryLast).toISOString(),
        quietMs: canaryLast - from,
        ...judgeWindow(canary, from, lastBeat ?? from, lateMs),
      });
    } else {
      // Nothing from the canary after the writers' last timestamp either. If it ran the command
      // and wrote down the command's exit, the process died on a host that was up to record it.
      // If it left no `end` line at all, it stopped with the writers.
      const verdict =
        canary.end?.reason === 'command_exit'
          ? 'command_exited'
          : canary.beats.length > 0 && canary.end === undefined
            ? 'host_stall'
            : 'unobserved';
      windows.push({
        ...tail,
        to: null,
        quietMs: null,
        verdict,
        beats: 0,
        silentMs: null,
        pauses: [],
      });
    }
  }
  return { writers: writers.length, points: points.length, windows };
}

function parseReadArgs(argv) {
  const options = {
    dir: undefined,
    beats: undefined,
    quietMs: 5000,
    lateMs: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--beats') options.beats = argv[++i];
    else if (arg === '--quiet-ms') options.quietMs = positiveInt(arg, argv[++i]);
    else if (arg === '--late-ms') options.lateMs = positiveInt(arg, argv[++i]);
    else if (arg.startsWith('-')) usage(`unknown flag ${arg}`);
    else if (options.dir === undefined) options.dir = arg;
    else usage('one run directory at a time');
  }
  if (options.dir === undefined) usage('read needs a run directory');
  if (options.beats === undefined) usage('read needs --beats <file>');
  return options;
}

function seconds(value) {
  return value === null || value === undefined ? '—' : `${(value / 1000).toFixed(1)}s`;
}

function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows
    .map((r) =>
      r
        .map((cell, c) => String(cell).padEnd(widths[c]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const READING = {
  writers_quiet: 'the canary kept beating: the host kept time, look at what the writers share',
  host_stall: 'the canary went silent with the writers: the host, not their work',
  mixed: 'the canary missed part of the window: the host explains only that part',
  unobserved: 'no canary beat on both sides of the window: nothing to tell the two apart',
  command_exited: 'the canary recorded the command exiting: the process died, the host was up',
};

function read(argv) {
  const options = parseReadArgs(argv);
  let report;
  try {
    const runDir = resolveRunDir(options.dir);
    const beatsPath = resolve(options.beats);
    if (!existsSync(beatsPath)) throw new Error(`no beats file at ${beatsPath}`);
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    const canary = parseBeats(readJsonl(beatsPath));
    // A beat later than three intervals is a missed beat unless told otherwise.
    const lateMs = options.lateMs ?? 3 * (canary.intervalMs ?? 1000);
    const result = quietWindows({
      run,
      sessions: readJsonl(join(runDir, 'sessions.jsonl')),
      steps: readJsonl(join(runDir, 'steps.jsonl')),
      events: readJsonl(join(runDir, 'events.jsonl')),
      canary,
      quietMs: options.quietMs,
      lateMs,
    });
    report = {
      runId: run.id,
      runDir,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      termination: run.termination?.kind ?? null,
      canary: {
        host: canary.host ?? null,
        pid: canary.pid ?? null,
        ranTheCommand: canary.childPid !== undefined,
        intervalMs: canary.intervalMs ?? null,
        beats: canary.beats.length,
        firstBeat: canary.beats.length > 0 ? new Date(canary.beats[0].t).toISOString() : null,
        lastBeat:
          canary.beats.length > 0
            ? new Date(canary.beats[canary.beats.length - 1].t).toISOString()
            : null,
        end: canary.end?.reason ?? null,
        commandExitCode: canary.end?.exitCode ?? null,
        commandSignal: canary.end?.reason === 'command_exit' ? (canary.end.signal ?? null) : null,
      },
      quietMs: options.quietMs,
      lateMs,
      ...result,
    };
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const origin = ms(report.startedAt) ?? ms(report.windows[0]?.from) ?? 0;
  const offset = (iso) => (iso === null ? '—' : seconds(ms(iso) - origin));
  const lines = [
    `${report.runId} ${report.termination ?? 'no termination on record'}: ${report.writers} sessions wrote ${report.points} timestamps; ${report.windows.length} quiet window(s) over ${seconds(report.quietMs)}`,
    `  canary on ${report.canary.host ?? 'an unnamed host'}: ${report.canary.beats} beats every ${report.canary.intervalMs ?? '?'} ms, late after ${report.lateMs} ms; ${
      report.canary.ranTheCommand
        ? 'it ran the command itself, so the two shared a host'
        : 'free-running: that it shared a host with the run is the operator’s word, the run record names no host'
    }`,
  ];
  if (report.windows.length > 0) {
    lines.push('');
    lines.push(
      table([
        ['#', 'from', 'to', 'quiet', 'in flight', 'beats', 'canary silent', 'verdict'],
        ...report.windows.map((w, i) => [
          i + 1,
          offset(w.from),
          w.open ? `${offset(w.to)} (open)` : offset(w.to),
          seconds(w.quietMs),
          w.inFlight.length,
          w.beats,
          seconds(w.silentMs),
          w.verdict,
        ]),
      ]),
    );
    lines.push('');
    report.windows.forEach((w, i) => {
      lines.push(`  ${i + 1} ${w.verdict}: ${READING[w.verdict]}`);
      for (const p of w.pauses) {
        lines.push(
          `      no beat from ${offset(p.from)} to ${offset(p.to)}: ${seconds(p.wallMs)} by the wall clock, ${seconds(p.monoMs)} by the monotonic clock`,
        );
      }
    });
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'beat') beat(rest);
  else if (command === 'read') read(rest);
  else usage(command === undefined ? '' : `unknown command ${command}`);
}
