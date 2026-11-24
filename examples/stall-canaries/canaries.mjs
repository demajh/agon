#!/usr/bin/env node
// Two no-op sibling writers beside a run, and the stall verdict read from them, as described in
// docs/stall-canaries.md. The pure canary only beats. The path canary writes one byte (and
// fsyncs it) into the directory the run writes to and opens a TCP connection to the address the
// run talks to, and beats only when both legs finished. The design is nim's.
//
//   node examples/stall-canaries/canaries.mjs replay [--verbose]
//       reads cases.jsonl, prints one verdict per host, exits 1 when one differs from the case
//   node examples/stall-canaries/canaries.mjs demo
//       starts both canaries and a stand-in writer on this host, breaks the socket path, freezes
//       the processes, freezes the writer alone, and checks the verdict in each phase
//   node examples/stall-canaries/canaries.mjs watch --dir <dir> --connect <host:port>
//         [--interval-ms 1000] [--silence-ms 5000] [--json] -- <command...>
//       runs <command> with both canaries beside it; <dir> is where the command writes
//
// Needs only Node >= 22. `demo` uses SIGSTOP and so needs a POSIX system.
import { fork, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CANARY_FILE = '.agon-path-canary';

// --- the verdict ------------------------------------------------------------------------------

export const VERDICTS = ['healthy', 'writers', 'shared_path', 'host_stalled', 'canary_fault'];

/**
 * Reads one host at one moment. Times are milliseconds on one clock.
 *
 *   since          when observation of this host began (a source that never beat is silent only
 *                  once `silenceMs` has passed since then)
 *   at             the moment of the reading
 *   silenceMs      how long without a beat counts as silent
 *   pureLastBeat   last beat of the pure canary, or null
 *   pathLastBeat   last beat of the path canary (both legs finished), or null
 *   pathAttempt    the path canary's latest attempt, `{ at, disk, socket }` with each leg
 *                  'ok' | 'failed' | 'timeout', or null
 *   writersLastWrite  last observed write of the real writers; null when they are not observed
 */
export function readStall(o) {
  const silent = (last) => o.at - (last ?? o.since) > o.silenceMs;
  const pure = silent(o.pureLastBeat);
  const path = silent(o.pathLastBeat);
  const writersObserved = o.writersLastWrite !== undefined && o.writersLastWrite !== null;
  const writers = writersObserved && silent(o.writersLastWrite);

  if (pure && path) {
    return { verdict: 'host_stalled', reason: 'neither canary beats: the host is not breathing' };
  }
  if (pure) {
    return {
      verdict: 'canary_fault',
      reason:
        'the path canary beats on this host, so the host runs; the pure canary itself is gone',
    };
  }
  if (path) {
    const attempt = o.pathAttempt;
    const fresh = attempt && attempt.at > (o.pathLastBeat ?? o.since);
    const bad = fresh ? ['disk', 'socket'].filter((leg) => attempt[leg] !== 'ok') : [];
    const leg = bad.length === 2 ? 'both' : (bad[0] ?? 'unknown');
    return {
      verdict: 'shared_path',
      leg,
      reason:
        leg === 'unknown'
          ? 'the host beats and the path canary has reported nothing since its last beat'
          : `the host beats and the path canary cannot finish: ${bad.map((l) => `${l} ${attempt[l]}`).join(', ')}`,
    };
  }
  if (writers) {
    return {
      verdict: 'writers',
      reason: 'both canaries beat on the same disk and socket: the silence is in the writers',
    };
  }
  return {
    verdict: 'healthy',
    reason: writersObserved ? 'canaries and writers all beat' : 'both canaries beat',
  };
}

// --- the canaries (child processes of the supervisor) ------------------------------------------

/** Only beats. It touches no file and no network socket: the beat goes up the fork channel. */
function pureCanary(intervalMs) {
  let seq = 0;
  setInterval(() => process.send({ canary: 'pure', seq: seq++ }), intervalMs);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function leg(run, ms) {
  try {
    await withTimeout(run(), ms);
    return 'ok';
  } catch (error) {
    return error instanceof Error && error.message === 'timeout' ? 'timeout' : 'failed';
  }
}

/** One byte, written and fsynced, in the directory the real writers use. */
async function writeByte(dir) {
  await mkdir(dir, { recursive: true });
  const handle = await open(join(dir, CANARY_FILE), 'w');
  try {
    await handle.write(Buffer.from([0x2e]), 0, 1, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Opens the connection the real writers open, and closes it without sending anything. */
function openSocket(host, port) {
  return new Promise((done, fail) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      done();
    });
    socket.once('error', (error) => {
      socket.destroy();
      fail(error);
    });
  });
}

/** Beats (`ok: true`) only when both legs finished; every attempt is reported with its legs. */
async function pathCanary(intervalMs, legMs, dir, host, port) {
  for (let seq = 0; ; seq++) {
    const [disk, socket] = await Promise.all([
      leg(() => writeByte(dir), legMs),
      leg(() => openSocket(host, port), legMs),
    ]);
    process.send({ canary: 'path', seq, ok: disk === 'ok' && socket === 'ok', disk, socket });
    await sleep(intervalMs);
  }
}

// --- the supervisor ----------------------------------------------------------------------------

/** Newest change under `dir`, ignoring the canary's own byte: file count, sizes and mtimes. */
async function signature(dir) {
  let sig = '';
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return sig;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === CANARY_FILE) continue;
    try {
      const s = await stat(join(entry.parentPath, entry.name));
      sig += `${entry.name}:${s.size}:${s.mtimeMs};`;
    } catch {
      // removed between the listing and the stat
    }
  }
  return sig;
}

/**
 * Starts both canaries for this host and keeps the three last-beat times. `observeWriters`
 * watches `dir` for changes as the sign that the real writers are writing.
 */
export function supervise({ dir, host, port, intervalMs, silenceMs, observeWriters }) {
  const now = () => performance.now();
  const state = {
    since: now(),
    pureLastBeat: null,
    pathLastBeat: null,
    pathAttempt: null,
    writersLastWrite: observeWriters ? now() : null,
  };
  const legMs = Math.max(intervalMs, Math.floor(silenceMs / 2));
  const children = {
    pure: fork(SELF, ['__pure', String(intervalMs)], { stdio: 'inherit' }),
    path: fork(SELF, ['__path', String(intervalMs), String(legMs), dir, host, String(port)], {
      stdio: 'inherit',
    }),
  };
  children.pure.on('message', () => {
    state.pureLastBeat = now();
  });
  children.path.on('message', (m) => {
    state.pathAttempt = { at: now(), disk: m.disk, socket: m.socket };
    if (m.ok) state.pathLastBeat = now();
  });

  let stopped = false;
  if (observeWriters) {
    (async () => {
      let last = await signature(dir);
      while (!stopped) {
        await sleep(intervalMs);
        const next = await signature(dir);
        if (next !== last) state.writersLastWrite = now();
        last = next;
      }
    })();
  }

  // The supervisor shares the host with the canaries. When its own tick comes late by more than
  // the silence threshold, the host (or this process) was frozen: it says so and starts the
  // observation again, because the canaries' beats from before the freeze prove nothing now.
  let lastTick = now();
  let frozenMs = 0;
  const ownBeat = setInterval(() => {
    const at = now();
    const late = at - lastTick - intervalMs;
    lastTick = at;
    if (late <= silenceMs) return;
    frozenMs += late;
    state.since = at;
    state.pureLastBeat = state.pathLastBeat = state.pathAttempt = null;
    if (observeWriters) state.writersLastWrite = at;
  }, intervalMs);
  /** The reading now; a freeze of the supervisor since the last reading is reported once. */
  const read = () => {
    if (frozenMs > 0) {
      const stalledMs = Math.round(frozenMs);
      frozenMs = 0;
      return {
        verdict: 'host_stalled',
        reason: `the supervisor's own tick came ${stalledMs} ms late: this host was frozen`,
        stalledMs,
      };
    }
    return readStall({ ...state, at: now(), silenceMs });
  };

  return {
    children,
    read,
    stop() {
      stopped = true;
      clearInterval(ownBeat);
      for (const child of Object.values(children)) child.kill('SIGKILL');
      rmSync(join(dir, CANARY_FILE), { force: true });
    },
  };
}

// --- replay ------------------------------------------------------------------------------------

function replay(verbose) {
  const file = join(dirname(SELF), 'cases.jsonl');
  const cases = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  let wrong = 0;
  for (const c of cases) {
    const got = readStall(c.observed);
    const label = got.leg ? `${got.verdict} (${got.leg})` : got.verdict;
    const expected = c.expect.leg ? `${c.expect.verdict} (${c.expect.leg})` : c.expect.verdict;
    const ok = label === expected;
    if (!ok) wrong++;
    process.stdout.write(
      `${ok ? 'ok  ' : 'FAIL'} ${c.case.padEnd(28)} ${c.host.padEnd(8)} ${label}${ok ? '' : `, expected ${expected}`}\n`,
    );
    if (verbose) process.stdout.write(`     ${got.reason}\n`);
  }
  process.stdout.write(`${cases.length - wrong}/${cases.length} cases read as written\n`);
  process.exit(wrong === 0 ? 0 : 1);
}

// --- demo --------------------------------------------------------------------------------------

async function demo() {
  if (process.platform === 'win32') {
    process.stderr.write('demo freezes processes with SIGSTOP and needs a POSIX system\n');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'agon-canaries-'));
  const intervalMs = 100;
  const silenceMs = 600;
  const listen = (server, port) =>
    new Promise((done) => server.listen(port, '127.0.0.1', () => done(server.address().port)));
  let target = createServer((socket) => socket.destroy());
  const port = await listen(target, 0);

  // The stand-in for the real writers: appends a row to a file in the same directory.
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(join(dir, 'sessions.jsonl'))}, '{}\\n'), ${intervalMs});`,
    ],
    { stdio: 'inherit' },
  );
  const sup = supervise({
    dir,
    host: '127.0.0.1',
    port,
    intervalMs,
    silenceMs,
    observeWriters: true,
  });
  const everyone = [sup.children.pure, sup.children.path, writer];
  const signal = (procs, sig) => procs.forEach((p) => p.kill(sig));

  const phases = [
    { name: 'everything runs', expect: 'healthy', enter: async () => {} },
    {
      name: 'the target stops accepting connections',
      expect: 'shared_path (socket)',
      enter: () => new Promise((done) => target.close(done)),
    },
    {
      name: 'the target is back',
      expect: 'healthy',
      enter: async () => {
        target = createServer((socket) => socket.destroy());
        await listen(target, port);
      },
    },
    {
      name: 'canaries and writer frozen (SIGSTOP)',
      expect: 'host_stalled',
      enter: async () => signal(everyone, 'SIGSTOP'),
    },
    {
      name: 'resumed (SIGCONT)',
      expect: 'healthy',
      enter: async () => signal(everyone, 'SIGCONT'),
    },
    {
      name: 'the writer alone frozen',
      expect: 'writers',
      enter: async () => signal([writer], 'SIGSTOP'),
    },
    {
      name: 'the pure canary killed',
      expect: 'canary_fault',
      enter: async () => {
        signal([writer], 'SIGCONT');
        signal([sup.children.pure], 'SIGKILL');
      },
    },
  ];

  let wrong = 0;
  try {
    for (const phase of phases) {
      await phase.enter();
      await sleep(silenceMs * 2.5);
      const got = sup.read();
      const label = got.leg ? `${got.verdict} (${got.leg})` : got.verdict;
      const ok = label === phase.expect;
      if (!ok) wrong++;
      process.stdout.write(
        `${ok ? 'ok  ' : 'FAIL'} ${phase.name.padEnd(40)} ${label}${ok ? '' : `, expected ${phase.expect}`}\n     ${got.reason}\n`,
      );
    }
  } finally {
    sup.stop();
    writer.kill('SIGKILL');
    target.close();
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(wrong === 0 ? 0 : 1);
}

// --- watch -------------------------------------------------------------------------------------

function usage(message) {
  process.stderr.write(
    `${message ? `${message}\n` : ''}usage: node examples/stall-canaries/canaries.mjs replay [--verbose]\n` +
      '       node examples/stall-canaries/canaries.mjs demo\n' +
      '       node examples/stall-canaries/canaries.mjs watch --dir <dir> --connect <host:port>\n' +
      '              [--interval-ms 1000] [--silence-ms 5000] [--json] -- <command...>\n',
  );
  process.exit(2);
}

function parseWatch(argv) {
  const split = argv.indexOf('--');
  if (split === -1 || split === argv.length - 1) usage('watch needs "-- <command...>"');
  const options = {
    intervalMs: 1000,
    silenceMs: 5000,
    json: false,
    command: argv.slice(split + 1),
  };
  const flags = argv.slice(0, split);
  const positive = (flag, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) usage(`${flag} needs a positive integer`);
    return n;
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--json') options.json = true;
    else if (flag === '--dir')
      options.dir = resolve(flags[++i] ?? usage('--dir needs a directory'));
    else if (flag === '--connect') {
      const value = flags[++i] ?? usage('--connect needs host:port');
      const at = value.lastIndexOf(':');
      if (at <= 0) usage('--connect needs host:port');
      options.host = value.slice(0, at);
      options.port = positive('--connect port', value.slice(at + 1));
    } else if (flag === '--interval-ms') options.intervalMs = positive(flag, flags[++i]);
    else if (flag === '--silence-ms') options.silenceMs = positive(flag, flags[++i]);
    else usage(`unknown flag ${flag}`);
  }
  if (options.dir === undefined) usage('watch needs --dir');
  if (options.host === undefined) usage('watch needs --connect');
  if (options.silenceMs < 2 * options.intervalMs)
    usage('--silence-ms must be at least twice --interval-ms');
  return options;
}

/** Everything `watch` prints goes to stderr, so the command's stdout stays the command's. */
function watch(argv) {
  const options = parseWatch(argv);
  const host = hostname();
  const sup = supervise({ ...options, observeWriters: true });
  const startedAt = performance.now();
  const msIn = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const changes = [];
  let current = 'healthy';
  let lastAt = startedAt;

  const tick = () => {
    const got = sup.read();
    const at = performance.now();
    // A freeze the supervisor slept through is booked to host_stalled, not to the verdict before.
    const frozen = got.stalledMs ?? 0;
    msIn[current] += Math.max(0, at - lastAt - frozen);
    msIn.host_stalled += frozen;
    lastAt = at;
    const label = got.leg ? `${got.verdict} (${got.leg})` : got.verdict;
    if (label !== current || frozen > 0) {
      changes.push({
        atMs: Math.round(at - startedAt),
        verdict: got.verdict,
        leg: got.leg,
        reason: got.reason,
      });
      process.stderr.write(
        `canaries ${host} +${((at - startedAt) / 1000).toFixed(1)}s ${label}: ${got.reason}\n`,
      );
    }
    current = frozen > 0 ? 'healthy' : label;
    if (!(current in msIn)) msIn[current] = 0;
  };
  const timer = setInterval(tick, options.intervalMs);

  const child = spawn(options.command[0], options.command.slice(1), { stdio: 'inherit' });
  const finish = (code) => {
    clearInterval(timer);
    tick();
    sup.stop();
    const summary = {
      host,
      observedMs: Math.round(performance.now() - startedAt),
      silenceMs: options.silenceMs,
      msIn: Object.fromEntries(Object.entries(msIn).map(([k, v]) => [k, Math.round(v)])),
      changes,
    };
    if (options.json) process.stderr.write(`${JSON.stringify(summary)}\n`);
    else {
      const parts = Object.entries(summary.msIn)
        .filter(([, ms]) => ms > 0)
        .map(([verdict, ms]) => `${verdict} ${(ms / 1000).toFixed(1)}s`);
      process.stderr.write(
        `canaries ${host} observed ${(summary.observedMs / 1000).toFixed(1)}s: ${parts.join(', ')}\n`,
      );
    }
    process.exit(code);
  };
  child.on('error', (error) => {
    process.stderr.write(`canaries: could not start ${options.command[0]}: ${error.message}\n`);
    finish(127);
  });
  child.on('exit', (code, sig) => finish(code ?? (sig ? 1 : 0)));
}

// --- entry -------------------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [mode = '', ...rest] = process.argv.slice(2);
  // A canary whose supervisor is gone has nobody to beat to.
  if (mode.startsWith('__')) process.on('disconnect', () => process.exit(0));
  if (mode === '__pure') pureCanary(Number(rest[0]));
  else if (mode === '__path') {
    await pathCanary(Number(rest[0]), Number(rest[1]), rest[2], rest[3], Number(rest[4]));
  } else if (mode === 'replay') replay(rest.includes('--verbose'));
  else if (mode === 'demo') await demo();
  else if (mode === 'watch') watch(rest);
  else usage();
}
