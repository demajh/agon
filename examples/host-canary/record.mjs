#!/usr/bin/env node
// Records the fixture in this directory: a run of the engine's offline fakes beside a canary
// (scripts/canary-beat.mjs), with two quiet stretches made on purpose.
//
//   node examples/host-canary/record.mjs <dir>
//
// 1. From 1.0 s to 3.5 s after the run starts, every model call waits: both sessions in flight
//    stop writing while the host is fine, as during a provider outage.
// 2. 5.0 s in, the run's process and the canary's are both stopped (SIGSTOP) for 2.5 s and then
//    continued: neither gets to run, which is what a stalled host does to them.
//
// Writes <dir>/beats.jsonl and <dir>/out/<runId>/. Run it from the repository root with a
// relative <dir> and the records carry no absolute path of yours except the export target. Needs the workspace built (`pnpm build`) and a
// POSIX host (SIGSTOP). No network, no model.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const CANARY = join(REPO_ROOT, 'scripts', 'canary-beat.mjs');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist');
const ENGINE_FAKES = join(REPO_ROOT, 'packages', 'engine', 'dist', 'fakes', 'index.js');

const STEP_MS = 120;
const OUTAGE = { fromMs: 1000, toMs: 3500 };
const FREEZE = { atMs: 5000, forMs: 2500 };

const CONFIG = `
version: 1
name: ledgerly-canary-demo
target:
  kind: web
  variants:
    control: { url: http://control.test }
    treatment: { url: http://treatment.test }
  capture: { analytics: [posthog], screenshots: never }
personas:
  - id: eager
    name: Eager user
    summary: You want this to work.
    traits: { role: owner, patience: 0.9, attention: 0.9 }
population: { seed: 1, size: 10, personas: [{ use: eager }], traitJitter: 0 }
scenarios:
  - { id: first-project, goal: Sign up and create a project., success: event:project_created, maxSteps: 12 }
metrics:
  - { id: activation, type: conversion, event: project_created, primary: true }
analysis: { method: fixed, minSessionsPerVariant: 1 }
defaults: { model: fake/model-1, temperature: 0 }
`;

/** The run itself, as `agon run --concurrency 2` with a scripted model and a scripted site. */
async function runFakes(dir) {
  const { FakeAdapter, FakeLlm, happyUser, ledgerlySite } = await import(ENGINE_FAKES);
  const { Output } = await import(join(CLI_DIST, 'output.js'));
  const { runCommand } = await import(join(CLI_DIST, 'commands', 'run.js'));
  const file = join(dir, 'agon.yaml');
  writeFileSync(file, CONFIG);

  const started = Date.now();
  const llm = new FakeLlm(happyUser);
  const generateObject = llm.generateObject.bind(llm);
  llm.generateObject = async (request) => {
    const elapsed = Date.now() - started;
    // Every call takes STEP_MS; a call made during the outage returns only when it is over.
    await sleep(
      elapsed >= OUTAGE.fromMs && elapsed < OUTAGE.toMs ? OUTAGE.toMs - elapsed : STEP_MS,
    );
    return generateObject(request);
  };

  const out = new Output({ json: true, color: false }, () => {});
  return runCommand(
    out,
    { file, out: join(dir, 'out'), llmMode: 'off', concurrency: 2 },
    { llm, adapter: new FakeAdapter(ledgerlySite) },
  );
}

async function record(dir) {
  if (!existsSync(ENGINE_FAKES) || !existsSync(join(CLI_DIST, 'bin.js'))) {
    throw new Error('run `pnpm build` first');
  }
  mkdirSync(dir, { recursive: true });
  const beats = join(dir, 'beats.jsonl');
  if (existsSync(beats)) throw new Error(`${beats} exists; record into an empty directory`);
  const self = relative(process.cwd(), fileURLToPath(import.meta.url));
  const canary = spawn(
    'node',
    [
      relative(process.cwd(), CANARY),
      ...['beat', '--out', beats, '--interval-ms', '250', '--host', 'fixture-host'],
      ...['--', 'node', self, '--run', dir],
    ],
    { stdio: 'inherit' },
  );
  const exited = new Promise((done) => canary.on('exit', (code) => done(code)));

  // The canary's first line names the process it started, and the run record says when the
  // run's clock started; the two processes are stopped together FREEZE.atMs after that.
  let childPid;
  let runStarted;
  while (childPid === undefined || runStarted === undefined) {
    await sleep(20);
    if (childPid === undefined && existsSync(beats)) {
      const first = readFileSync(beats, 'utf8').split('\n')[0];
      if (first) childPid = JSON.parse(first).childPid;
    }
    const out = join(dir, 'out');
    const runDir = existsSync(out) ? readdirSync(out).find((n) => n.startsWith('run_')) : undefined;
    if (runDir !== undefined && existsSync(join(out, runDir, 'run.json'))) {
      runStarted = Date.parse(
        JSON.parse(readFileSync(join(out, runDir, 'run.json'), 'utf8')).startedAt,
      );
    }
  }
  await sleep(Math.max(0, runStarted + FREEZE.atMs - Date.now()));
  process.kill(childPid, 'SIGSTOP');
  process.kill(canary.pid, 'SIGSTOP');
  await sleep(FREEZE.forMs);
  process.kill(canary.pid, 'SIGCONT');
  process.kill(childPid, 'SIGCONT');

  const code = await exited;
  process.stdout.write(`recorded into ${dir} (the run exited ${code})\n`);
  return code;
}

const args = process.argv.slice(2);
if (args[0] === '--run' && args[1] !== undefined) process.exit(await runFakes(args[1]));
else if (args.length === 1 && !args[0].startsWith('-')) process.exit(await record(args[0]));
else {
  process.stderr.write('usage: node examples/host-canary/record.mjs <dir>\n');
  process.exit(2);
}
