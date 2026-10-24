#!/usr/bin/env node
// The confirm, lapse and reopen steps proposed in docs/reopen-a-lapsed-row.md. Each case in
// cases.jsonl is a finding as Agon files it today, the confirmation window it would carry, and
// what happened afterwards: the close, re-runs by would-be confirmers, reopen attempts. The script
// replays the events against an append-only store, lapses a closed row whose window ran out
// without an eligible re-run, turns a reopen into a new linked row, checks that no row is edited
// after it lapses, and compares the final rows with the ones written in the case.
//
// Run after `pnpm build` (it imports @agon/spec from its built dist/ by path):
//   node examples/reopen/replay.mjs          one line per row
//   node examples/reopen/replay.mjs --log    every record the store wrote, as JSONL
// Exits 1 when a row differs from the one written in cases.jsonl, or a lapsed row changed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FindingSchema, closeFinding, hashValue } from '../../packages/spec/dist/index.js';

// --- the window -------------------------------------------------------------------------------

/** `P7D` style durations only: the publication cycle of the counted thing, in whole days. */
function cycleMs(cycle) {
  const m = /^P(\d+)D$/.exec(cycle);
  if (!m) throw new Error(`cycle ${cycle}: only whole days (P<n>D) are handled here`);
  return Number(m[1]) * 86_400_000;
}

/** The window opens when the row closes and runs for `cycles` publication cycles. */
function dueAt(row) {
  const ms = Date.parse(row.closedAt) + row.confirmation.cycles * cycleMs(row.confirmation.cycle);
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Eligible: named in the window, and not the observer whose observation is being confirmed. */
function eligibility(row, by) {
  if (by === row.settlement.observer) return `${by} made the observation being confirmed`;
  if (!row.confirmation.eligible.includes(by)) return `${by} is not an eligible confirmer`;
  return null;
}

// --- the store --------------------------------------------------------------------------------

/**
 * Rows are appended, closed once, confirmed once, lapsed once. After a lapse a row is frozen; its
 * digest is taken then and checked at the end. Every write and every refusal goes to the log.
 */
function replay(c) {
  const rows = new Map();
  const reruns = new Map(); // row id -> re-runs inside the window that did not confirm
  const frozen = new Map(); // row id -> digest at lapse
  const log = [];
  const record = (at, event, fields) => log.push({ case: c.case, at, event, ...fields });

  const append = (row, at) => {
    rows.set(row.id, row);
    reruns.set(row.id, []);
    record(at, 'filed', {
      row: row.id,
      ...(row.reopens ? { reopens: row.reopens, reopenedBy: row.reopenedBy } : {}),
    });
  };

  /** Lazy: a window is looked at when something touches the row, and at the end of the replay. */
  const sweep = (now) => {
    for (const row of rows.values()) {
      if (row.status !== 'closed_fixed' || row.confirmed || !row.confirmation) continue;
      const due = dueAt(row);
      if (now < due) continue;
      const tried = reruns.get(row.id);
      const lapsed = {
        ...row,
        status: 'unconfirmed',
        lapse: {
          lapsedAt: due,
          recordedAt: now,
          window: row.confirmation,
          reason: tried.length === 0 ? 'no_rerun' : 'no_eligible_rerun',
          ineligibleReruns: tried,
        },
      };
      rows.set(row.id, lapsed);
      frozen.set(row.id, hashValue(lapsed));
      record(now, 'lapsed', { row: row.id, lapsedAt: due, reason: lapsed.lapse.reason });
    }
  };

  const base = FindingSchema.parse(c.finding);
  append({ ...base, confirmation: c.confirmation }, base.createdAt);

  for (const e of c.events) {
    sweep(e.at);
    const id = e.row ?? c.finding.id;
    const row = rows.get(id);
    if (!row) throw new Error(`${c.case}: no row ${id}`);

    if (e.type === 'close') {
      // The existing close path: status, closedAt from the store's clock, the observer's stamp.
      const { confirmation, reopens, reopenedBy, rederivation, ...finding } = row;
      const closed = closeFinding(FindingSchema.parse(finding), e.status, e.at, e.observation);
      rows.set(id, { ...closed, confirmation, reopens, reopenedBy, rederivation });
      record(e.at, 'closed', { row: id, status: e.status, dueAt: dueAt(rows.get(id)) });
    } else if (e.type === 'confirm') {
      if (row.status === 'unconfirmed') {
        record(e.at, 'refused', {
          row: id,
          by: e.by,
          reason: `window ended ${row.lapse.lapsedAt}; attach the re-run as a re-derivation to reopen`,
        });
        continue;
      }
      if (row.status !== 'closed_fixed' || row.confirmed) {
        record(e.at, 'refused', { row: id, by: e.by, reason: `row is ${row.status}` });
        continue;
      }
      const why = eligibility(row, e.by);
      if (why) {
        reruns.get(id).push({ by: e.by, at: e.at, under: e.under, why });
        record(e.at, 'refused', { row: id, by: e.by, reason: why });
        continue;
      }
      rows.set(id, {
        ...row,
        confirmed: { by: e.by, at: e.at, under: e.under, verdict: e.verdict },
      });
      record(e.at, 'confirmed', { row: id, by: e.by, under: e.under });
    } else if (e.type === 'reopen') {
      // Anyone may reopen, the filer included; what they must bring is a fresh re-derivation.
      if (row.status !== 'unconfirmed') {
        record(e.at, 'refused', {
          row: id,
          by: e.by,
          reason: `only an unconfirmed row reopens; this one is ${row.status}`,
        });
        continue;
      }
      if (!e.rederivation) {
        record(e.at, 'refused', {
          row: id,
          by: e.by,
          reason: 'a reopen carries a fresh re-derivation',
        });
        continue;
      }
      const n = [...rows.values()].filter((r) => r.reopens === id).length + 1;
      const fresh = FindingSchema.parse({
        id: `${id}.r${n}`,
        receiptId: row.receiptId,
        invariant: row.invariant,
        impact: row.impact,
        closureOwner: row.closureOwner,
        settlement: { predicate: row.settlement.predicate, observer: row.settlement.observer },
        requirementsDigest: row.requirementsDigest,
        createdAt: e.at,
      });
      append(
        {
          ...fresh,
          confirmation: row.confirmation,
          reopens: id,
          reopenedBy: e.by,
          rederivation: e.rederivation,
        },
        e.at,
      );
    } else {
      throw new Error(`${c.case}: unknown event ${e.type}`);
    }
  }
  sweep(c.asOf);

  const edited = [...frozen].filter(([id, digest]) => hashValue(rows.get(id)) !== digest);
  return { rows: [...rows.values()], log, edited: edited.map(([id]) => id) };
}

// --- the runner -------------------------------------------------------------------------------

const summary = (row) => ({
  id: row.id,
  status: row.status,
  ...(row.lapse ? { lapseReason: row.lapse.reason } : {}),
  ...(row.reopens ? { reopens: row.reopens, reopenedBy: row.reopenedBy } : {}),
  ...(row.confirmed ? { confirmedBy: row.confirmed.by } : {}),
});

const here = dirname(fileURLToPath(import.meta.url));
const cases = readFileSync(join(here, 'cases.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const results = cases.map((c) => {
  const r = replay(c);
  const got = r.rows.map(summary);
  const ok = r.edited.length === 0 && hashValue(got) === hashValue(c.expect);
  return { c, ...r, got, ok };
});

if (process.argv.includes('--log')) {
  for (const r of results) for (const l of r.log) console.log(JSON.stringify(l));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad('case', 18)}${pad('row', 18)}${pad('status', 14)}${pad('lapse', 19)}${pad('reopens', 14)}${pad('by', 8)}confirmed by`,
  );
  for (const r of results) {
    for (const s of r.got) {
      console.log(
        `${pad(r.c.case, 18)}${pad(s.id, 18)}${pad(s.status, 14)}${pad(s.lapseReason ?? '-', 19)}${pad(s.reopens ?? '-', 14)}${pad(s.reopenedBy ?? '-', 8)}${s.confirmedBy ?? '-'}`,
      );
    }
  }
  const lapsedRows = results.reduce((n, r) => n + r.rows.filter((x) => x.lapse).length, 0);
  const edited = results.flatMap((r) => r.edited);
  console.log(`\nlapsed rows unchanged after lapse: ${lapsedRows - edited.length}/${lapsedRows}`);
  console.log(`cases as written: ${results.filter((r) => r.ok).length}/${results.length}`);
}

process.exitCode = results.every((r) => r.ok) ? 0 : 1;
