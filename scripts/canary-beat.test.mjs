// Exercises scripts/canary-beat.mjs: the reader against the recorded fixture under
// examples/host-canary and against small synthetic records, and the beat writer as a process.
// Needs only Node; run with `node --test scripts/canary-beat.test.mjs`.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { judgeWindow, parseBeats, quietWindows } from './canary-beat.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'canary-beat.mjs');
const FIXTURE = join(REPO_ROOT, 'examples', 'host-canary');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/** A canary beating every second from `fromMs` to `toMs`, silent inside each [a, b] of `gaps`. */
function canary(fromMs, toMs, { gaps = [], end } = {}) {
  const rows = [{ kind: 'start', host: 'h1', pid: 1, intervalMs: 1000, t: iso(fromMs) }];
  for (let t = fromMs; t <= toMs; t += 1000) {
    if (gaps.some(([a, b]) => t > a && t < b)) continue;
    rows.push({ kind: 'beat', seq: rows.length - 1, t: iso(t), monoMs: t - fromMs, lateMs: 0 });
  }
  if (end !== undefined) rows.push({ kind: 'end', t: iso(toMs), ...end });
  return parseBeats(rows);
}

/** Two sessions stepping once a second from 0 to 30 s, both silent between 10 s and 20 s. */
function quietPair({ finished = true, untilMs = 30_000 } = {}) {
  const steps = [];
  for (const sessionId of ['ses_a', 'ses_b']) {
    for (let t = 0; t < untilMs; t += 1000) {
      if (t >= 10_000 && t < 20_000) continue;
      steps.push({ sessionId, startedAt: iso(t), durationMs: 1000 });
    }
  }
  const sessions = finished
    ? ['ses_a', 'ses_b'].map((id) => ({ id, startedAt: iso(0), finishedAt: iso(untilMs) }))
    : [];
  const run = { id: 'run_x', startedAt: iso(0), ...(finished ? { finishedAt: iso(untilMs) } : {}) };
  return { run, sessions, steps, events: [] };
}

const read = (record, beats) =>
  quietWindows({ ...record, canary: beats, quietMs: 5000, lateMs: 3000 }).windows;

describe('scripts/canary-beat.mjs read', () => {
  it('tells the two quiet windows of the recorded fixture apart', () => {
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        'read',
        FIXTURE,
        '--beats',
        join(FIXTURE, 'beats.jsonl'),
        '--quiet-ms',
        '1000',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.canary.ranTheCommand, true);
    assert.deepEqual(
      report.windows.map((w) => [w.verdict, w.inFlight.length, w.open]),
      [
        ['writers_quiet', 2, false],
        ['host_stall', 2, false],
      ],
    );
    assert.ok(report.windows[0].beats >= 8);
    assert.ok(report.windows[1].beats <= 1);
    assert.ok(report.windows[1].silentMs / report.windows[1].quietMs > 0.9);
    assert.equal(report.windows[1].pauses.length, 1);
  });

  it('calls a window the canary beat through writers_quiet', () => {
    const [w] = read(quietPair(), canary(-2000, 32_000));
    assert.equal(w.verdict, 'writers_quiet');
    assert.equal(w.quietMs, 10_000);
    assert.deepEqual(w.inFlight, ['ses_a', 'ses_b']);
    assert.equal(w.silentMs, 0);
  });

  it('calls a window the canary missed host_stall, and a partly missed one mixed', () => {
    const [stall] = read(quietPair(), canary(-2000, 32_000, { gaps: [[9000, 20_000]] }));
    assert.equal(stall.verdict, 'host_stall');
    assert.equal(stall.silentMs, 10_000);
    const [mixed] = read(quietPair(), canary(-2000, 32_000, { gaps: [[10_000, 14_000]] }));
    assert.equal(mixed.verdict, 'mixed');
    assert.equal(mixed.silentMs, 4000);
  });

  it('refuses to judge a window the canary does not span', () => {
    const [late] = read(quietPair(), canary(15_000, 32_000));
    assert.equal(late.verdict, 'unobserved');
    const [none] = read(quietPair(), parseBeats([]));
    assert.equal(none.verdict, 'unobserved');
    assert.equal(judgeWindow(canary(0, 5000), 1000, 9000, 3000).verdict, 'unobserved');
  });

  it('reads the end of a run that never finished from what the canary did next', () => {
    const dead = quietPair({ finished: false, untilMs: 25_000 });
    // A free-running canary that kept beating: the writers stopped on a live host.
    const outlived = read(dead, canary(-2000, 60_000)).at(-1);
    assert.equal(outlived.open, true);
    assert.equal(outlived.verdict, 'writers_quiet');
    assert.deepEqual(outlived.inFlight, ['ses_a', 'ses_b']);
    // A canary whose record stops where theirs does, with no end line: they stopped together.
    const together = read(dead, canary(-2000, 25_000)).at(-1);
    assert.equal(together.verdict, 'host_stall');
    assert.equal(together.to, null);
    // A canary that ran the command and wrote down its exit: the process died, the host did not.
    const exited = read(
      dead,
      canary(-2000, 25_000, { end: { reason: 'command_exit', signal: 'SIGKILL' } }),
    ).at(-1);
    assert.equal(exited.verdict, 'command_exited');
  });
});

describe('scripts/canary-beat.mjs beat', () => {
  const rows = (file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it('beats beside a command and exits with its code', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agon-canary-')), 'beats.jsonl');
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        'beat',
        '--out',
        file,
        '--interval-ms',
        '50',
        '--host',
        'h1',
        '--',
        process.execPath,
        '-e',
        'setTimeout(() => process.exit(3), 400)',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 3, r.stderr);
    const written = rows(file);
    assert.equal(written[0].kind, 'start');
    assert.equal(written[0].host, 'h1');
    assert.equal(typeof written[0].childPid, 'number');
    const beats = written.filter((row) => row.kind === 'beat');
    assert.ok(beats.length >= 4, `only ${beats.length} beats`);
    assert.deepEqual(
      beats.map((b) => b.seq),
      beats.map((_, i) => i),
    );
    assert.deepEqual(
      {
        kind: written.at(-1).kind,
        reason: written.at(-1).reason,
        exitCode: written.at(-1).exitCode,
      },
      { kind: 'end', reason: 'command_exit', exitCode: 3 },
    );
  });

  it('beats on its own until signalled, and says so', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agon-canary-')), 'beats.jsonl');
    const child = spawn(process.execPath, [SCRIPT, 'beat', '--out', file, '--interval-ms', '50']);
    await new Promise((done) => setTimeout(done, 400));
    child.kill('SIGTERM');
    const code = await new Promise((done) => child.on('exit', done));
    assert.equal(code, 0);
    const written = rows(file);
    assert.equal(written[0].childPid, undefined);
    assert.ok(written.filter((row) => row.kind === 'beat').length >= 3);
    assert.equal(written.at(-1).reason, 'signal');
  });

  it('refuses to start without --out', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'beat'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /beat needs --out/);
  });
});
