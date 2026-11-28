// Exercises scripts/blind-run.mjs: a commitment read from a result.json the real CLI wrote (fake
// LLM and adapter, then `agon compare`), the refusals, and the two sets under examples/blind-run.
// Needs `pnpm build` and `uv sync --project packages/stats` first; run with
// `node --test scripts/blind-run.test.mjs`.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'blind-run.mjs');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist');
const ENGINE_FAKES = join(REPO_ROOT, 'packages', 'engine', 'dist', 'fakes', 'index.js');
const EXAMPLES = join(REPO_ROOT, 'examples', 'blind-run');

const CONFIG = `
version: 1
name: ledgerly-blind-test
target:
  kind: web
  variants:
    control: { url: http://control.test }
    treatment: { url: http://treatment.test }
  capture: { analytics: [posthog] }
personas:
  - id: eager
    name: Eager user
    summary: You want this to work.
    traits: { role: owner, patience: 0.9, attention: 0.9 }
population: { seed: 1, size: 4, personas: [{ use: eager }], traitJitter: 0 }
scenarios:
  - { id: first-project, goal: Sign up and create a project., success: event:project_created, maxSteps: 12 }
metrics:
  - { id: activation, type: conversion, event: project_created, primary: true }
analysis: { method: fixed, minSessionsPerVariant: 1 }
defaults: { model: fake/model-1, temperature: 0 }
`;

const NONCE = '5f1c0a9e7d3b4c2a8e6f0b1d';

function blind(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, text: r.stdout + r.stderr };
}

/** Records a run with the engine's fakes, then analyzes it with the built CLI. */
async function recordAndCompare(dir) {
  const { FakeAdapter, FakeLlm, happyUser, ledgerlySite } = await import(ENGINE_FAKES);
  const { Output } = await import(join(CLI_DIST, 'output.js'));
  const { runCommand } = await import(join(CLI_DIST, 'commands', 'run.js'));
  const file = join(dir, 'agon.yaml');
  writeFileSync(file, CONFIG);
  const out = new Output({ json: true, color: false }, () => {});
  const code = await runCommand(
    out,
    { file, out: join(dir, 'out'), llmMode: 'off' },
    { llm: new FakeLlm(happyUser), adapter: new FakeAdapter(ledgerlySite) },
  );
  assert.equal(code, 0);
  const outDir = join(dir, 'out');
  const compare = spawnSync(process.execPath, [join(CLI_DIST, 'bin.js'), 'compare', outDir], {
    encoding: 'utf8',
  });
  assert.equal(compare.status, 0, compare.stdout + compare.stderr);
  return join(
    outDir,
    readdirSync(outDir).find((n) => n.startsWith('run_')),
  );
}

/** A set of two sealed tests: both arms convert alike in one, the treatment wins the other. */
function makeSet(dir) {
  mkdirSync(dir);
  const outcomes = [
    {
      test: 'flat-one',
      nonce: `${NONCE}a`,
      control: { visitors: 5000, conversions: 150 },
      treatment: { visitors: 5000, conversions: 152 },
    },
    {
      test: 'b-wins',
      nonce: `${NONCE}b`,
      control: { visitors: 3000, conversions: 90 },
      treatment: { visitors: 3000, conversions: 130 },
    },
  ];
  const priv = join(dir, 'private.jsonl');
  writeFileSync(priv, outcomes.map((o) => `${JSON.stringify(o)}\n`).join(''));
  const sealed = blind(['seal', priv]);
  assert.equal(sealed.code, 0, sealed.text);
  const seals = sealed.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  writeFileSync(join(dir, 'protocol.json'), JSON.stringify({ set: 'test-set', alpha: 0.05 }));
  writeFileSync(
    join(dir, 'tests.jsonl'),
    seals.map((s) => `${JSON.stringify({ ...s, kind: 'buy_box' })}\n`).join(''),
  );
  return outcomes;
}

function reveal(dir, outcome, extra) {
  appendFileSync(join(dir, 'outcomes.jsonl'), `${JSON.stringify({ ...outcome, ...extra })}\n`);
}

describe('scripts/blind-run.mjs', () => {
  let work;
  let runDir;

  before(async () => {
    assert.ok(
      existsSync(ENGINE_FAKES) && existsSync(join(CLI_DIST, 'bin.js')),
      'run `pnpm build` first',
    );
    work = mkdtempSync(join(tmpdir(), 'agon-blind-'));
    runDir = await recordAndCompare(work);
  });

  it('commits the verdict of a result.json agon compare wrote, then scores it after the reveal', () => {
    const dir = join(work, 'set-a');
    const [flat, bWins] = makeSet(dir);
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(result.decision.verdict, 'inconclusive');

    const first = blind(['commit', dir, 'flat-one', runDir, '--json']);
    assert.equal(first.code, 0, first.text);
    const row = JSON.parse(first.stdout);
    assert.equal(row.call, 'flat');
    assert.equal(row.source, 'result');
    assert.equal(row.resultId, result.id);
    assert.equal(row.requirementsDigest, result.requirementsDigest);
    assert.equal(blind(['commit', dir, 'b-wins', '--verdict', 'inconclusive']).code, 0);

    const again = blind(['commit', dir, 'flat-one', '--verdict', 'ship']);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already has a commitment/);

    const sealed = JSON.parse(blind(['score', dir, '--json']).stdout);
    assert.deepEqual(
      sealed.rows.map((r) => r.status),
      ['sealed', 'sealed'],
    );
    assert.equal(sealed.groups.at(-1).hitRate, null);

    const head = blind(['head', dir]).stdout.trim();
    const revealedAt = new Date(Date.now() + 60_000).toISOString();
    reveal(dir, flat, { revealedAt, sawHead: head });
    reveal(dir, bWins, { revealedAt, sawHead: head });
    const report = JSON.parse(blind(['score', dir, '--json']).stdout);
    assert.deepEqual(
      report.rows.map((r) => r.result),
      ['hit', 'flat_on_winner'],
    );
    const all = report.groups.at(-1);
    assert.deepEqual(
      [all.scored, all.hits, all.wrongWinner, all.winnerOnFlat, all.flatOnWinner, all.realFlat],
      [2, 1, 0, 0, 1, 1],
    );
  });

  it('does not score an outcome that differs from its seal, or one revealed before the call', () => {
    const dir = join(work, 'set-b');
    const [flat, bWins] = makeSet(dir);
    const late = blind(['commit', dir, 'flat-one', '--verdict', 'ship']);
    assert.equal(late.code, 0, late.text);
    const headBefore = blind(['head', dir]).stdout.trim();
    assert.equal(blind(['commit', dir, 'b-wins', '--verdict', 'ship']).code, 0);
    const revealedAt = new Date(Date.now() + 60_000).toISOString();
    reveal(
      dir,
      { ...flat, treatment: { visitors: 5000, conversions: 220 } },
      { revealedAt, sawHead: blind(['head', dir]).stdout.trim() },
    );
    reveal(dir, bWins, { revealedAt, sawHead: headBefore });
    const report = JSON.parse(blind(['score', dir, '--json']).stdout);
    assert.deepEqual(
      report.rows.map((r) => r.status),
      ['seal_mismatch', 'revealed_unseen'],
    );
    assert.equal(report.groups.at(-1).scored, 0);
    assert.match(blind(['score', dir]).stdout, /undefined \(0 scored\)/);
  });

  it('refuses a call on a revealed test and a chain edited after the fact', () => {
    const dir = join(work, 'set-c');
    const [flat, bWins] = makeSet(dir);
    reveal(dir, bWins, { revealedAt: new Date().toISOString() });
    const open = blind(['commit', dir, 'b-wins', '--verdict', 'ship']);
    assert.equal(open.code, 2);
    assert.match(open.stderr, /not blind/);

    assert.equal(blind(['commit', dir, 'flat-one', '--verdict', 'ship']).code, 0);
    const path = join(dir, 'commitments.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"call":"B"', '"call":"flat"'));
    const edited = blind(['score', dir]);
    assert.equal(edited.code, 2);
    assert.match(edited.stderr, /changed after it was written/);
    assert.ok(flat);
  });

  it('prints the invented set as the example shows it', () => {
    const report = JSON.parse(blind(['score', join(EXAMPLES, 'invented'), '--json']).stdout);
    const by = Object.fromEntries(report.groups.map((g) => [g.kind, g]));
    const counts = (g) => [
      g.hits,
      g.scored,
      g.wrongWinner,
      g.winnerOnFlat,
      g.flatOnWinner,
      g.noCall,
      g.realFlat,
    ];
    assert.deepEqual(counts(by.hero_headline), [2, 4, 0, 2, 0, 1, 4]);
    assert.deepEqual(counts(by.buy_box), [2, 4, 1, 0, 1, 0, 1]);
    assert.deepEqual(counts(by.all), [4, 8, 1, 2, 1, 1, 5]);
    assert.deepEqual(by.buy_box.notScored, { revealed_unseen: 1, sealed: 1 });
  });

  it('scores nothing in the open-book set and reproduces the posted p-values', () => {
    const dir = join(EXAMPLES, 'open-book');
    const report = JSON.parse(blind(['score', dir, '--json']).stdout);
    assert.equal(report.rows.length, 9);
    assert.ok(report.rows.every((r) => r.status === 'open_book'));
    assert.equal(report.groups.at(-1).hitRate, null);
    const outcomes = readFileSync(join(dir, 'outcomes.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const o of outcomes.filter((x) => x.postedP !== undefined)) {
      const row = report.rows.find((r) => r.test === o.test);
      assert.equal(row.p.toFixed(3), o.postedP.toFixed(3), o.test);
      assert.equal(row.real, 'flat');
    }
  });
});
