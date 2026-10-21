#!/usr/bin/env node
// Fixes the trial count M at run time, so `agon compare` cannot be handed a smaller one later.
//
//   node scripts/pin-trials.mjs pin     <run dir | out dir> [--ledger-dir <dir>] [--json]
//   node scripts/pin-trials.mjs check   <run dir | out dir> [--ledger-dir <dir>] [--json]
//   node scripts/pin-trials.mjs compare <run dir | out dir> [agon compare options...]
//
// `pin` runs right after `agon run`: it reads the ledger the run wrote to, resolved exactly as the
// CLI resolves it (`--ledger-dir`, else `<parent of the output directory>/.agon/ledger`), and
// writes `trials` (M at that moment), `ledgerDir`, `ledgerPath`, `ledgerEntries` and `pinnedAt`
// into run.json. `check` resolves the ledger again from the arguments `agon compare` would be
// given and refuses (exit 2) when the path differs from the pinned one, M is below the pinned
// count, or the append-only ledger holds fewer entries than it did; it always prints the path it
// actually read. `compare` is `check` followed by `agon compare` with the same
// arguments. The CLI itself keeps reading run.json through RunSchema, which ignores the extra
// keys. Requires `pnpm build` (imports @agon/spec and runs packages/cli/dist/bin.js).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerEntrySchema, RunSchema, countTrials } from '@agon/spec';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGON_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');
const EXIT_REFUSED = 2;
const EXIT_USAGE = 1;

class Refusal extends Error {}

/** Same rule as the CLI: a directory holding run.json, else the newest run under it. */
function resolveRunDir(input) {
  const dir = resolve(input);
  if (existsSync(join(dir, 'run.json'))) return dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Refusal(`${dir} is not a run directory`);
  const runs = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => existsSync(join(p, 'run.json')))
    .map((p) => ({ p, createdAt: readRunJson(p).createdAt }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (runs.length === 0)
    throw new Refusal(`no runs found under ${dir} (expected <dir>/<runId>/run.json)`);
  return runs[0].p;
}

function readRunJson(runDir) {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
}

/** Same rule as `agon compare`: `--ledger-dir`, else `<parent of the output directory>/.agon/ledger`. */
function resolveLedgerDir(runDir, override) {
  return override === undefined
    ? join(dirname(dirname(runDir)), '.agon', 'ledger')
    : resolve(override);
}

/** The ledger file for a sample, read the way FileLedger reads it: one entry per line. */
function readLedger(ledgerDir, sampleHash) {
  const path = join(ledgerDir, `${sampleHash}.jsonl`);
  if (!existsSync(path)) return { path, exists: false, entries: [] };
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Refusal(`${path}:${i + 1}: not a ledger entry`);
      return parsed.data;
    });
  return { path, exists: true, entries };
}

function describeLedger(ledger, trials) {
  return ledger.exists
    ? `${ledger.path} (${ledger.entries.length} entries, M=${trials})`
    : `${ledger.path} (missing; an empty ledger counts as M=1)`;
}

function loadRun(target) {
  const runDir = resolveRunDir(target);
  const raw = readRunJson(runDir);
  const run = RunSchema.parse(raw);
  if (run.sampleHash === undefined)
    throw new Refusal(`${runDir} has no sampleHash; it was recorded before the ledger existed`);
  return { runDir, raw, run };
}

function pin(target, options) {
  const { runDir, raw, run } = loadRun(target);
  if (raw.trials !== undefined || raw.ledgerDir !== undefined)
    throw new Refusal(
      `${join(runDir, 'run.json')} is already pinned (trials M=${raw.trials} from ${raw.ledgerDir} at ${raw.pinnedAt}); a pin is written once, at run time`,
    );
  const ledgerDir = resolveLedgerDir(runDir, options.ledgerDir);
  const ledger = readLedger(ledgerDir, run.sampleHash);
  const trials = countTrials(ledger.entries);
  const pinned = {
    ...raw,
    trials,
    ledgerDir,
    ledgerPath: ledger.path,
    ledgerEntries: ledger.entries.length,
    pinnedAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(pinned, null, 2)}\n`);
  return {
    ok: true,
    runDir,
    sampleHash: run.sampleHash,
    trials,
    ledgerDir,
    ledgerPath: ledger.path,
    ledgerEntries: ledger.entries.length,
    ledgerExists: ledger.exists,
    lines: [
      `pinned ${run.id}: trials M=${trials} against sample ${run.sampleHash.slice(0, 12)}`,
      `  ledger read: ${describeLedger(ledger, trials)}`,
      ...(ledger.exists
        ? []
        : [
            `  warning: the ledger file does not exist; agon run writes it before the first session, so this run was a dry run or wrote to another --ledger-dir`,
          ]),
    ],
  };
}

function check(target, options) {
  const { runDir, raw, run } = loadRun(target);
  const ledgerDir = resolveLedgerDir(runDir, options.ledgerDir);
  const ledger = readLedger(ledgerDir, run.sampleHash);
  const trials = countTrials(ledger.entries);
  const report = {
    runDir,
    sampleHash: run.sampleHash,
    trials,
    ledgerDir,
    ledgerPath: ledger.path,
    ledgerEntries: ledger.entries.length,
    ledgerExists: ledger.exists,
    pinnedTrials: raw.trials,
    pinnedLedgerDir: raw.ledgerDir,
    pinnedLedgerEntries: raw.ledgerEntries,
  };
  const read = `  ledger read: ${describeLedger(ledger, trials)}`;
  if (typeof raw.trials !== 'number' || typeof raw.ledgerDir !== 'string')
    return {
      ...report,
      ok: false,
      reason: 'not_pinned',
      lines: [
        `refused: ${join(runDir, 'run.json')} carries no pinned trial count; run \`pin\` right after agon run`,
        read,
      ],
    };
  if (ledgerDir !== raw.ledgerDir)
    return {
      ...report,
      ok: false,
      reason: 'ledger_dir_differs',
      lines: [
        `refused: ledger path differs from the one pinned at run time`,
        `  pinned:      ${raw.ledgerDir} (M=${raw.trials})`,
        `  would read:  ${ledgerDir}`,
        read,
      ],
    };
  if (trials < raw.trials)
    return {
      ...report,
      ok: false,
      reason: 'trials_below_pinned',
      lines: [
        `refused: trials M=${trials} is below the M=${raw.trials} pinned at run time; the ledger lost entries or was replaced`,
        read,
      ],
    };
  // The ledger is append-only, so the entry count can no more fall than M can.
  if (typeof raw.ledgerEntries === 'number' && ledger.entries.length < raw.ledgerEntries)
    return {
      ...report,
      ok: false,
      reason: 'entries_below_pinned',
      lines: [
        `refused: the ledger holds ${ledger.entries.length} entries, fewer than the ${raw.ledgerEntries} pinned at run time; an append-only ledger cannot shrink`,
        read,
      ],
    };
  const rose = trials > raw.trials;
  return {
    ...report,
    ok: true,
    reason: rose ? 'trials_rose' : 'match',
    lines: [
      rose
        ? `ok: trials M=${trials}, up from the pinned M=${raw.trials}; more variants were started against this sample since the run, and agon compare will use the higher count`
        : `ok: trials M=${trials} matches the count pinned at run time`,
      read,
    ],
  };
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ledger-dir') {
      options.ledgerDir = argv[i + 1];
      passthrough.push(arg, argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--ledger-dir=')) {
      options.ledgerDir = arg.slice('--ledger-dir='.length);
      passthrough.push(arg);
    } else if (arg === '--json') {
      options.json = true;
      passthrough.push(arg);
    } else if (arg.startsWith('-')) {
      passthrough.push(arg);
      // Options with a value: keep the value with its flag so agon compare sees it.
      if (!arg.includes('=') && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        passthrough.push(argv[i + 1]);
        i += 1;
      }
    } else positional.push(arg);
  }
  return { positional, options, passthrough };
}

function emit(result, json, stream = process.stdout) {
  if (json) {
    const { lines, ...rest } = result;
    stream.write(`${JSON.stringify(rest, null, 2)}\n`);
  } else stream.write(`${result.lines.join('\n')}\n`);
}

function usage() {
  process.stderr.write(
    [
      'usage:',
      '  node scripts/pin-trials.mjs pin     <run dir | out dir> [--ledger-dir <dir>] [--json]',
      '  node scripts/pin-trials.mjs check   <run dir | out dir> [--ledger-dir <dir>] [--json]',
      '  node scripts/pin-trials.mjs compare <run dir | out dir> [agon compare options...]',
      '',
    ].join('\n'),
  );
  return EXIT_USAGE;
}

function main(argv) {
  const [command, ...rest] = argv;
  const { positional, options, passthrough } = parseArgs(rest);
  const target = positional[0];
  if (target === undefined || positional.length > 1) return usage();
  try {
    if (command === 'pin') {
      emit(pin(target, options), options.json);
      return 0;
    }
    if (command === 'check') {
      const result = check(target, options);
      emit(result, options.json);
      return result.ok ? 0 : EXIT_REFUSED;
    }
    if (command === 'compare') {
      // The check goes to stderr so stdout stays agon compare's own output (text or --json).
      const result = check(target, options);
      emit(result, false, process.stderr);
      if (!result.ok) return EXIT_REFUSED;
      if (!existsSync(AGON_BIN))
        throw new Refusal(`${AGON_BIN} is missing; run \`pnpm build\` first`);
      const child = spawnSync(process.execPath, [AGON_BIN, 'compare', target, ...passthrough], {
        stdio: 'inherit',
      });
      return child.status ?? 1;
    }
    return usage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return EXIT_REFUSED;
  }
}

process.exitCode = main(process.argv.slice(2));
