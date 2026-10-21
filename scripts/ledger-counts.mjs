#!/usr/bin/env node
// Prints the slot counts of an evaluation ledger side by side: opened, filled, missed, voided
// and still open, per role, for every sample in the files or directories given. A slot is one
// (run, variant key) pair; `started` opens it, `completed` fills it, `discarded` misses it and
// `voided` (see docs/trial-ledger.md) closes it as a mistake. Nothing in this repository writes
// a `voided` row yet, so that column reads 0 against any ledger Agon has produced.
//
//   node scripts/ledger-counts.mjs <ledger file | ledger dir>... [--json]
//
// The default ledger directory in local mode is `.agon/ledger`, next to the output directory's
// parent. Reads the JSONL directly, without the Zod schema, so the script has no dependencies.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const CLOSING = { completed: 'filled', discarded: 'missed', voided: 'voided' };
const COLUMNS = ['opened', 'filled', 'missed', 'voided', 'open'];

function ledgerFiles(target) {
  if (statSync(target).isDirectory())
    return readdirSync(target)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => join(target, n));
  return [target];
}

function readEntries(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`${file}:${i + 1}: not JSON`);
      }
      for (const field of ['sampleHash', 'runId', 'variantKey', 'role', 'event', 'at'])
        if (typeof entry[field] !== 'string')
          throw new Error(`${file}:${i + 1}: ledger entry without "${field}"`);
      return entry;
    });
}

/** One slot per (run, variant key), closed by the last completed/discarded/voided entry. */
function slots(entries) {
  const byKey = new Map();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const id = `${e.runId} ${e.variantKey}`;
    let slot = byKey.get(id);
    if (slot === undefined) {
      slot = {
        runId: e.runId,
        variantKey: e.variantKey,
        role: e.role,
        openedAt: undefined,
        state: 'open',
        closedBy: undefined,
      };
      byKey.set(id, slot);
    }
    if (e.event === 'started' && slot.openedAt === undefined) slot.openedAt = e.at;
    const state = CLOSING[e.event];
    if (state !== undefined) {
      slot.state = state;
      slot.closedBy = e;
    }
  }
  return [...byKey.values()];
}

function trials(entries) {
  const keys = new Set(
    entries.filter((e) => e.event === 'started' && e.role === 'treatment').map((e) => e.variantKey),
  );
  return Math.max(1, keys.size);
}

function count(slotList) {
  const counts = { opened: 0, filled: 0, missed: 0, voided: 0, open: 0 };
  for (const s of slotList) {
    counts.opened += 1;
    counts[s.state] += 1;
  }
  return counts;
}

function summarize(file) {
  const entries = readEntries(file);
  const all = slots(entries);
  const roles = {};
  for (const role of ['treatment', 'control'])
    roles[role] = count(all.filter((s) => s.role === role));
  return {
    file,
    sampleHash: entries[0]?.sampleHash ?? basename(file, '.jsonl'),
    entries: entries.length,
    trials: trials(entries),
    roles,
    openSlots: all
      .filter((s) => s.state === 'open')
      .map((s) => ({ runId: s.runId, variantKey: s.variantKey, openedAt: s.openedAt })),
    voids: all
      .filter((s) => s.state === 'voided')
      .map((s) => ({
        runId: s.runId,
        variantKey: s.variantKey,
        at: s.closedBy.at,
        reason: s.closedBy.reason,
        voidedBy: s.closedBy.voidedBy,
      })),
  };
}

function printText(summary) {
  console.log(
    `sample ${summary.sampleHash.slice(0, 12)} · M = ${summary.trials} distinct treatment variant(s) started · ${summary.entries} entries · ${summary.file}`,
  );
  console.log();
  const width = 9;
  console.log(['role'.padEnd(width), ...COLUMNS.map((c) => c.padStart(7))].join(' '));
  for (const [role, counts] of Object.entries(summary.roles))
    console.log(
      [role.padEnd(width), ...COLUMNS.map((c) => String(counts[c]).padStart(7))].join(' '),
    );
  console.log();
  for (const s of summary.openSlots)
    console.log(
      `  open     ${s.runId}  ${s.variantKey}  started ${s.openedAt ?? '(no started row)'}`,
    );
  for (const v of summary.voids)
    console.log(
      `  voided   ${v.runId}  ${v.variantKey}  ${v.at}  reason: ${v.reason ?? '(none)'}  signed by: ${v.voidedBy ?? '(nobody)'}`,
    );
  if (summary.voids.length === 0)
    console.log(
      '  no void rows: nothing in this repository writes event "voided" yet (docs/trial-ledger.md)',
    );
  console.log(
    '  opened = filled + missed + voided + open; a slot that stays open is an omission, not a result',
  );
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const targets = args.filter((a) => a !== '--json');
if (targets.length === 0) {
  console.error('usage: node scripts/ledger-counts.mjs <ledger file | ledger dir>... [--json]');
  process.exit(2);
}

try {
  const summaries = targets.flatMap(ledgerFiles).map(summarize);
  if (json) console.log(JSON.stringify(summaries, null, 2));
  else
    summaries.forEach((s, i) => {
      if (i > 0) console.log();
      printText(s);
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
