// Exercises scripts/pin-trials.mjs against a run recorded by the real CLI (fake LLM and adapter).
// Needs `pnpm build` first; run with `node --test scripts/pin-trials.test.mjs`.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'pin-trials.mjs');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist');
const ENGINE_FAKES = join(REPO_ROOT, 'packages', 'engine', 'dist', 'fakes', 'index.js');

const CONFIG = `
version: 1
name: ledgerly-pin-test
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

function pinTrials(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, text: r.stdout + r.stderr };
}

/** Records a run the way `agon run --llm-mode off` does, with the engine's fakes in place of a model and a browser. */
async function recordRun(dir) {
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
  const runDir = join(
    outDir,
    readdirSync(outDir).find((n) => n.startsWith('run_')),
  );
  return { outDir, runDir, ledgerDir: join(dir, '.agon', 'ledger') };
}

describe('scripts/pin-trials.mjs', () => {
  let work;
  let run;

  before(async () => {
    assert.ok(
      existsSync(ENGINE_FAKES) && existsSync(join(CLI_DIST, 'bin.js')),
      'run `pnpm build` first',
    );
    work = mkdtempSync(join(tmpdir(), 'agon-pin-'));
    run = await recordRun(work);
  });

  it('pins trials and the resolved ledger path into run.json, once', () => {
    const first = pinTrials(['pin', run.outDir, '--json']);
    assert.equal(first.code, 0, first.text);
    const pinned = JSON.parse(first.stdout);
    assert.equal(pinned.trials, 1);
    assert.equal(pinned.ledgerDir, run.ledgerDir);
    assert.ok(pinned.ledgerExists);
    const raw = JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf8'));
    assert.equal(raw.trials, 1);
    assert.equal(raw.ledgerDir, run.ledgerDir);
    assert.equal(raw.ledgerPath, join(run.ledgerDir, `${raw.sampleHash}.jsonl`));
    assert.ok(typeof raw.pinnedAt === 'string');

    const again = pinTrials(['pin', run.runDir]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already pinned/);
  });

  it('passes when the ledger compare would read is the pinned one with the pinned count', () => {
    const r = pinTrials(['check', run.runDir]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.stdout, /^ok: trials M=1 matches/m);
    assert.match(r.stdout, /ledger read: .*\.jsonl \(4 entries, M=1\)/);
  });

  it('refuses another --ledger-dir and prints the path it would have read', () => {
    const empty = join(work, 'elsewhere');
    mkdirSync(empty);
    const r = pinTrials(['check', run.runDir, '--ledger-dir', empty, '--json']);
    assert.equal(r.code, 2, r.text);
    const report = JSON.parse(r.stdout);
    assert.equal(report.reason, 'ledger_dir_differs');
    assert.equal(report.ledgerDir, empty);
    assert.equal(report.ledgerExists, false);
    assert.equal(report.trials, 1);
    const text = pinTrials(['check', run.runDir, '--ledger-dir', empty]);
    assert.match(text.stdout, /refused: ledger path differs/);
    assert.match(text.stdout, /missing; an empty ledger counts as M=1/);
  });

  it('refuses a copy of the ledger under another path even when M matches', () => {
    const copy = join(work, 'copy');
    cpSync(run.ledgerDir, copy, { recursive: true });
    const r = pinTrials(['check', run.runDir, '--ledger-dir', copy, '--json']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).reason, 'ledger_dir_differs');
  });

  it('accepts a count that rose since the pin and refuses one that fell', () => {
    const raw = JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf8'));
    const path = join(run.ledgerDir, `${raw.sampleHash}.jsonl`);
    const original = readFileSync(path, 'utf8');
    const extra = {
      sampleHash: raw.sampleHash,
      runId: 'run_0000000000000000',
      variant: 'treatment',
      variantKey: 'treatment@ffffffffffff',
      role: 'treatment',
      event: 'started',
      at: new Date().toISOString(),
    };
    appendFileSync(path, `${JSON.stringify(extra)}\n`);
    const rose = pinTrials(['check', run.runDir, '--json']);
    assert.equal(rose.code, 0, rose.text);
    assert.deepEqual(
      (({ reason, trials, pinnedTrials }) => ({ reason, trials, pinnedTrials }))(
        JSON.parse(rose.stdout),
      ),
      { reason: 'trials_rose', trials: 2, pinnedTrials: 1 },
    );

    writeFileSync(path, original);
    const pinnedHigher = { ...raw, trials: 3 };
    writeFileSync(join(run.runDir, 'run.json'), `${JSON.stringify(pinnedHigher, null, 2)}\n`);
    const fell = pinTrials(['check', run.runDir]);
    assert.equal(fell.code, 2);
    assert.match(fell.stdout, /refused: trials M=1 is below the M=3 pinned/);
    writeFileSync(join(run.runDir, 'run.json'), `${JSON.stringify(raw, null, 2)}\n`);

    // Deleting the file leaves M at the floor of 1, equal to the pin; the entry count catches it.
    rmSync(path);
    const gone = pinTrials(['check', run.runDir, '--json']);
    assert.equal(gone.code, 2, gone.text);
    const report = JSON.parse(gone.stdout);
    assert.equal(report.reason, 'entries_below_pinned');
    assert.equal(report.ledgerExists, false);
    assert.equal(report.pinnedLedgerEntries, 4);
    writeFileSync(path, original);
  });

  it('refuses a run that was never pinned', () => {
    const raw = JSON.parse(readFileSync(join(run.runDir, 'run.json'), 'utf8'));
    const { trials, ledgerDir, ledgerPath, ledgerEntries, pinnedAt, ...unpinned } = raw;
    const other = join(work, 'unpinned', 'run_unpinned0000000');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'run.json'), `${JSON.stringify(unpinned, null, 2)}\n`);
    const r = pinTrials(['check', other, '--json']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).reason, 'not_pinned');
    assert.equal(trials, 1);
    assert.equal(ledgerEntries, 4);
    assert.ok(ledgerDir && ledgerPath && pinnedAt);
  });

  it('compare refuses before agon compare runs, and otherwise hands over to it', () => {
    const empty = join(work, 'elsewhere');
    const refused = pinTrials([
      'compare',
      run.runDir,
      '--ledger-dir',
      empty,
      '--min-sessions',
      '1',
    ]);
    assert.equal(refused.code, 2, refused.text);
    assert.match(refused.stderr, /refused: ledger path differs/);
    assert.equal(refused.stdout, '');
    assert.ok(!existsSync(join(run.runDir, 'result.json')));

    const ok = pinTrials(['compare', run.runDir, '--min-sessions', '1', '--json']);
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.stderr, /^ok: trials M=1 matches/m);
    const output = JSON.parse(ok.stdout);
    assert.equal(output.trials, 1);
    assert.match(output.result.decision.rationale, /Trials: M=1/);
    assert.ok(existsSync(join(run.runDir, 'result.json')));
  });
});
