#!/usr/bin/env node
// Blind scoring of simulated verdicts against real A/B tests with known outcomes.
//
//   node scripts/blind-run.mjs seal    <private outcomes.jsonl>            # test owner: one seal per test
//   node scripts/blind-run.mjs commit  <set dir> <test id> <run dir | output dir>
//   node scripts/blind-run.mjs commit  <set dir> <test id> --verdict ship|kill|inconclusive|continue
//   node scripts/blind-run.mjs head    <set dir>                           # the chain head to publish
//   node scripts/blind-run.mjs score   <set dir> [--json]
//
// A set directory holds `protocol.json` (the rules, fixed first), `tests.jsonl` (one row per real
// test with the seal of its outcome), `commitments.jsonl` (append-only and hash-chained: one dated
// call per test, read from the `result.json` that `agon compare` wrote) and `outcomes.jsonl` (the
// revealed outcomes). `score` counts a test only when its outcome matches its seal and was revealed
// after the commitment, and prints the hit rate with three miss counts beside it, per test kind:
// wrong winner, winner called on a flat test, flat called where the real test had a winner.
// The procedure is in docs/blind-run.md. Needs only Node.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GENESIS = '0'.repeat(64);
const CALLS = { ship: 'B', kill: 'A', inconclusive: 'flat', continue: 'no_call' };

class Refusal extends Error {}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with object keys sorted at every level, so two parties hash the same bytes. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** The seal covers what the outcome is, never when it was revealed or which head the owner saw. */
export function sealOf(outcome) {
  const { test, nonce, control, treatment } = outcome;
  return sha256(canonical({ test, nonce, control, treatment }));
}

function normalCdf(z) {
  // Abramowitz and Stegun 7.1.26 on erf; absolute error below 1.5e-7.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * The real side's rule: a two-sided pooled two-proportion z-test on conversions over visitors.
 * B (treatment) or A (control) wins when p < alpha; otherwise the test is flat.
 */
export function classifyReal(control, treatment, alpha) {
  const ok = (arm) =>
    arm !== undefined &&
    Number.isInteger(arm.visitors) &&
    Number.isInteger(arm.conversions) &&
    arm.visitors > 0 &&
    arm.conversions >= 0 &&
    arm.conversions <= arm.visitors;
  if (!ok(control) || !ok(treatment)) return undefined;
  const pA = control.conversions / control.visitors;
  const pB = treatment.conversions / treatment.visitors;
  const pooled =
    (control.conversions + treatment.conversions) / (control.visitors + treatment.visitors);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.visitors + 1 / treatment.visitors));
  if (se === 0) return { real: 'flat', z: 0, p: 1 };
  const z = (pB - pA) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { real: p < alpha ? (z > 0 ? 'B' : 'A') : 'flat', z, p };
}

/** `ship` a treatment is B, `kill` (control is best) is A, `inconclusive` is flat, `continue` is no call. */
export function callOf(verdict) {
  const call = CALLS[verdict];
  if (call === undefined)
    throw new Refusal(
      `unknown verdict ${JSON.stringify(verdict)}; expected ${Object.keys(CALLS).join(' | ')}`,
    );
  return call;
}

/** A run directory as given, or the newest `run_*` directory under an output directory. */
function resolveRunDir(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, 'run.json'))) return root;
  const runs = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.startsWith('run_') && existsSync(join(root, name, 'run.json')))
        .map((name) => join(root, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (runs.length === 0)
    throw new Refusal(`no run.json in ${root} or in a run_* directory under it`);
  return runs[0];
}

export function loadSet(dir) {
  const root = resolve(dir);
  const protocolPath = join(root, 'protocol.json');
  if (!existsSync(protocolPath))
    throw new Refusal(`${protocolPath} is missing; fix the protocol first`);
  const protocolText = readFileSync(protocolPath, 'utf8');
  const protocol = JSON.parse(protocolText);
  if (typeof protocol.alpha !== 'number' || !(protocol.alpha > 0 && protocol.alpha < 1))
    throw new Refusal('protocol.json needs alpha, the level of the real tests, between 0 and 1');
  return {
    root,
    protocol,
    protocolDigest: sha256(protocolText),
    tests: readJsonl(join(root, 'tests.jsonl')),
    commitments: readJsonl(join(root, 'commitments.jsonl')),
    outcomes: readJsonl(join(root, 'outcomes.jsonl')),
  };
}

function rowHash(row) {
  const { hash: _hash, ...rest } = row;
  return sha256(canonical(rest));
}

/** Every row names the hash of the row before it; the first names 64 zeros. */
export function verifyChain(commitments) {
  let prev = GENESIS;
  commitments.forEach((row, i) => {
    if (row.seq !== i + 1) throw new Refusal(`commitments.jsonl row ${i + 1}: seq is ${row.seq}`);
    if (row.prev !== prev)
      throw new Refusal(`commitments.jsonl row ${i + 1}: prev does not name the row before it`);
    if (rowHash(row) !== row.hash)
      throw new Refusal(`commitments.jsonl row ${i + 1}: the row was changed after it was written`);
    prev = row.hash;
  });
  return prev;
}

/** The commitment row for a result.json as `agon compare` wrote it. */
function fromResult(runDir) {
  const path = join(runDir, 'result.json');
  if (!existsSync(path))
    throw new Refusal(`${path} is missing; run \`agon compare\` on the run first`);
  const bytes = readFileSync(path);
  const result = JSON.parse(bytes.toString('utf8'));
  const primary = (result.metrics ?? []).find((m) => m.metricId === result.primaryMetricId);
  if (primary === undefined || primary.variants.length !== 2)
    throw new Refusal(
      `${path}: a blind call needs exactly two variants on the primary metric, found ${primary?.variants.length ?? 0}`,
    );
  const verdict = result.decision?.verdict;
  const call = callOf(verdict);
  if (call === 'B' && result.decision.variant === result.control)
    throw new Refusal(`${path}: ship names the control variant`);
  return {
    source: 'result',
    verdict,
    call,
    variant: result.decision.variant,
    control: result.control,
    resultId: result.id,
    runId: result.runId,
    resultDigest: sha256(bytes),
    method: result.method,
    primaryMetricId: result.primaryMetricId,
    sessionsAnalyzed: result.sessionsAnalyzed,
    calibrationProfile: result.calibration?.profile,
    requirementsDigest: result.requirementsDigest,
  };
}

export function commit(dir, testId, { runDir, verdict, at } = {}) {
  const set = loadSet(dir);
  const test = set.tests.find((t) => t.id === testId);
  if (test === undefined) throw new Refusal(`${testId} is not in tests.jsonl`);
  if (typeof test.seal !== 'string' && test.blind !== false)
    throw new Refusal(
      `${testId} has no seal; the owner seals the outcome before any call is committed`,
    );
  const prev = verifyChain(set.commitments);
  const earlier = set.commitments.find((c) => c.test === testId);
  if (earlier !== undefined)
    throw new Refusal(
      `${testId} already has a commitment (seq ${earlier.seq}, ${earlier.call}, ${earlier.committedAt}); one call per test`,
    );
  if (set.outcomes.some((o) => o.test === testId))
    throw new Refusal(`${testId} already has a revealed outcome; a call made now is not blind`);
  const body =
    runDir !== undefined
      ? fromResult(resolveRunDir(runDir))
      : { source: 'manual', verdict, call: callOf(verdict) };
  const row = {
    seq: set.commitments.length + 1,
    test: testId,
    kind: test.kind,
    ...body,
    protocolDigest: set.protocolDigest,
    committedAt: at ?? new Date().toISOString(),
    prev,
  };
  if (Number.isNaN(Date.parse(row.committedAt))) throw new Refusal(`--at ${at} is not a date`);
  row.hash = rowHash(row);
  appendFileSync(join(set.root, 'commitments.jsonl'), `${JSON.stringify(row)}\n`);
  return row;
}

function missOf(call, real) {
  if (call === real) return 'hit';
  if (call === 'flat') return 'flat_on_winner';
  return real === 'flat' ? 'winner_on_flat' : 'wrong_winner';
}

/** One row per test: what was called, what happened, and whether the pair may be counted. */
export function scoreSet(set) {
  const head = verifyChain(set.commitments);
  const seqByHash = new Map(set.commitments.map((c) => [c.hash, c.seq]));
  const rows = set.tests.map((test) => {
    const commitment = set.commitments.find((c) => c.test === test.id);
    const outcome = set.outcomes.find((o) => o.test === test.id);
    const row = { test: test.id, kind: test.kind ?? 'unstated', call: commitment?.call };
    if (commitment !== undefined) {
      row.committedAt = commitment.committedAt;
      row.source = commitment.source;
    }
    if (outcome !== undefined) {
      const computed = classifyReal(outcome.control, outcome.treatment, set.protocol.alpha);
      if (computed !== undefined) Object.assign(row, { real: computed.real, p: computed.p });
      else if (outcome.posted !== undefined)
        Object.assign(row, { real: outcome.posted, posted: true });
      row.revealedAt = outcome.revealedAt;
    }
    row.status = statusOf(test, commitment, outcome, row, set, seqByHash);
    if (row.status === 'scored') row.result = missOf(row.call, row.real);
    return row;
  });
  const known = new Set(set.tests.map((t) => t.id));
  for (const c of set.commitments)
    if (!known.has(c.test))
      throw new Refusal(`commitment seq ${c.seq} names ${c.test}, not in tests.jsonl`);
  const kinds = [...new Set([...(set.protocol.kinds ?? []), ...rows.map((r) => r.kind)])];
  const groups = [
    ...kinds.map((kind) =>
      tally(
        kind,
        rows.filter((r) => r.kind === kind),
      ),
    ),
    tally('all', rows),
  ];
  return {
    set: set.protocol.set,
    alpha: set.protocol.alpha,
    head,
    protocolDigest: set.protocolDigest,
    rows,
    groups,
  };
}

function statusOf(test, commitment, outcome, row, set, seqByHash) {
  if (test.blind === false) return 'open_book';
  if (commitment === undefined) return outcome === undefined ? 'pending' : 'no_commitment';
  if (commitment.protocolDigest !== set.protocolDigest) return 'protocol_changed';
  if (outcome === undefined) return 'sealed';
  if (sealOf(outcome) !== test.seal) return 'seal_mismatch';
  if (row.real === undefined || row.posted === true) return 'no_counts';
  // Order by what the owner saw: the reveal names a chain head that already holds the commitment.
  const sawSeq = seqByHash.get(outcome.sawHead);
  if (sawSeq === undefined || sawSeq < commitment.seq) return 'revealed_unseen';
  if (!(Date.parse(commitment.committedAt) < Date.parse(outcome.revealedAt)))
    return 'revealed_early';
  if (commitment.call === 'no_call') return 'no_call';
  return 'scored';
}

function tally(kind, rows) {
  const scored = rows.filter((r) => r.status === 'scored');
  const count = (result) => scored.filter((r) => r.result === result).length;
  const notScored = {};
  for (const r of rows)
    if (r.status !== 'scored' && r.status !== 'no_call')
      notScored[r.status] = (notScored[r.status] ?? 0) + 1;
  return {
    kind,
    tests: rows.length,
    scored: scored.length,
    hits: count('hit'),
    hitRate: scored.length === 0 ? null : count('hit') / scored.length,
    wrongWinner: count('wrong_winner'),
    winnerOnFlat: count('winner_on_flat'),
    flatOnWinner: count('flat_on_winner'),
    noCall: rows.filter((r) => r.status === 'no_call').length,
    realFlat: scored.filter((r) => r.real === 'flat').length,
    notScored,
  };
}

function table(header, rows) {
  const all = [header, ...rows].map((r) => r.map(String));
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all
    .map((r) =>
      r
        .map((cell, i) => cell.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function rate(hits, n) {
  return n === 0 ? 'undefined (0 scored)' : `${hits}/${n} = ${((100 * hits) / n).toFixed(0)}%`;
}

export function formatReport(report) {
  const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '-');
  const lines = [
    `${report.set ?? 'blind set'} · real tests classed at alpha ${report.alpha} · chain head ${report.head.slice(0, 12)}`,
    '',
    table(
      ['test', 'kind', 'committed', 'call', 'revealed', 'real', 'p', 'status'],
      report.rows.map((r) => [
        r.test,
        r.kind,
        day(r.committedAt),
        r.call ?? '-',
        day(r.revealedAt),
        r.real === undefined ? '-' : r.posted ? `${r.real} (as posted)` : r.real,
        r.p === undefined ? '-' : r.p.toFixed(3),
        r.status === 'scored' ? r.result : `not scored: ${r.status}`,
      ]),
    ),
    '',
    table(
      [
        'kind',
        'hit rate',
        'wrong winner',
        'winner on flat',
        'flat on winner',
        'no call',
        'not scored',
        'always-flat',
      ],
      report.groups.map((g) => [
        g.kind,
        rate(g.hits, g.scored),
        g.wrongWinner,
        g.winnerOnFlat,
        g.flatOnWinner,
        g.noCall,
        Object.entries(g.notScored)
          .map(([status, n]) => `${n} ${status}`)
          .join(', ') || '0',
        rate(g.realFlat, g.scored),
      ]),
    ),
    '',
    'always-flat: the hit rate of calling every scored test flat. A hit rate at or below it adds nothing.',
    'Simulated forecasts scored against real tests. A hit rate over a handful of tests is a count, not a calibration.',
  ];
  return lines.join('\n');
}

function usage(message) {
  process.stderr.write(
    `${message}\nusage: node scripts/blind-run.mjs seal <outcomes.jsonl>\n` +
      '       node scripts/blind-run.mjs commit <set dir> <test id> (<run dir | output dir> | --verdict <v>) [--at <iso>]\n' +
      '       node scripts/blind-run.mjs head <set dir>\n' +
      '       node scripts/blind-run.mjs score <set dir> [--json]\n',
  );
  process.exit(1);
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') flags.json = true;
    else if (rest[i] === '--verdict' || rest[i] === '--at') flags[rest[i].slice(2)] = rest[++i];
    else if (rest[i].startsWith('--')) usage(`unknown option ${rest[i]}`);
    else args.push(rest[i]);
  }
  if (command === 'seal') {
    if (args.length !== 1) usage('seal takes the private outcomes file');
    for (const outcome of readJsonl(resolve(args[0]))) {
      if (typeof outcome.nonce !== 'string' || outcome.nonce.length < 16)
        throw new Refusal(
          `${outcome.test}: the outcome needs a random nonce of 16 characters or more`,
        );
      process.stdout.write(`${JSON.stringify({ id: outcome.test, seal: sealOf(outcome) })}\n`);
    }
    return 0;
  }
  if (command === 'commit') {
    const [dir, testId, runDir] = args;
    if (dir === undefined || testId === undefined)
      usage('commit takes a set directory and a test id');
    if ((runDir === undefined) === (flags.verdict === undefined))
      usage('commit takes a run directory or --verdict, not both');
    const row = commit(dir, testId, { runDir, verdict: flags.verdict, at: flags.at });
    process.stdout.write(
      flags.json
        ? `${JSON.stringify(row)}\n`
        : `committed ${row.test}: ${row.call} (${row.verdict}, ${row.source}) at ${row.committedAt}\nchain head ${row.hash}\n`,
    );
    return 0;
  }
  if (command === 'head') {
    if (args.length !== 1) usage('head takes a set directory');
    process.stdout.write(`${verifyChain(loadSet(args[0]).commitments)}\n`);
    return 0;
  }
  if (command === 'score') {
    if (args.length !== 1) usage('score takes a set directory');
    const report = scoreSet(loadSet(args[0]));
    process.stdout.write(
      flags.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
    );
    return 0;
  }
  return usage(command === undefined ? 'no command' : `unknown command ${command}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof SyntaxError)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    process.exit(2);
  }
}
