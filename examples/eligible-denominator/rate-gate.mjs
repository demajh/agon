#!/usr/bin/env node
// Rate rows that carry their eligible rows, and the reader gate that refuses a rate without them,
// as described in docs/results-contract.md ("Rates carry their eligible rows"). A rate row keeps
// four counts beside its numerator: raw, ineligible (by reason), eligible and measured. The value
// is numerator / measured when something was measured and undefined otherwise; a reader refuses a
// rate whose eligible count is missing or zero instead of printing it as 0.00.
//
// The design point is RushantsBro's, from a conversation on Moltbook: "Does your results contract
// require a denominator to declare how many of its rows were eligible, or only how the numerator
// was read?"
//
// Run after `pnpm build` (it imports the built packages by path, so it needs no package of its own):
//   node examples/eligible-denominator/rate-gate.mjs
// Exits 1 when a grade or a printed value differs from the one written in rate-rows.jsonl.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_REGISTRY,
  ValidationError,
  missingFields,
} from '../../packages/spec/dist/index.js';
import { RowGate } from '../../packages/exporters/dist/index.js';

// --- the reader's registry --------------------------------------------------------------------

/** The set this reader relies on: the numerator and all four counts of its denominator. */
export const RATE_SET = 'example.rate_row.1';
const RATE_SET_VERSION = '2026-10-23.1';

/** A producer whose contract says how the numerator was read and nothing about eligibility. */
const NUMERATOR_ONLY_SET = 'vendor.rate_row.0';

const IDENTITY = ['id', 'runId', 'metricId', 'variant'];

export const registry = {
  generation: CONTRACT_REGISTRY.generation + 1,
  sets: {
    ...CONTRACT_REGISTRY.sets,
    [RATE_SET]: {
      version: RATE_SET_VERSION,
      fields: [
        ...IDENTITY,
        'numerator',
        'denominator.raw',
        'denominator.ineligible',
        'denominator.eligible',
        'denominator.measured',
      ],
    },
    [NUMERATOR_ONLY_SET]: {
      version: '2026-10-01.1',
      fields: [...IDENTITY, 'numerator', 'denominator.raw'],
    },
  },
};

/** The writer side: refuses to stamp a rate row that lacks a field of the set. */
export function stampRateRow(row, requiredSet = RATE_SET) {
  const set = registry.sets[requiredSet];
  const missing = missingFields(row, set.fields);
  if (missing.length > 0) {
    throw new ValidationError(`cannot stamp with ${requiredSet}: missing ${missing.join(', ')}`, {
      requiredSet,
      missing,
    });
  }
  return { ...row, schemaVersion: set.version, requiredSet };
}

// --- the rate check ---------------------------------------------------------------------------

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * Grades the denominator of a row that passed the gate. Only RATE_DEFINED is served as a rate;
 * every other grade keeps the row as a record of its counts and prints no number.
 */
export function gradeRate(row) {
  const { numerator, denominator: d } = row;
  if (!isCount(d.eligible)) return { grade: 'RATE_ELIGIBLE_MISSING' };
  if (
    !isCount(numerator) ||
    !isCount(d.raw) ||
    !isCount(d.measured) ||
    !Array.isArray(d.ineligible)
  ) {
    return { grade: 'RATE_COUNTS_INCONSISTENT' };
  }
  for (const entry of d.ineligible) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      return { grade: 'RATE_REASON_MISSING' };
    }
    if (!isCount(entry.rows)) return { grade: 'RATE_COUNTS_INCONSISTENT' };
  }
  const ineligible = d.ineligible.reduce((sum, entry) => sum + entry.rows, 0);
  if (d.raw !== d.eligible + ineligible || d.measured > d.eligible || numerator > d.measured) {
    return { grade: 'RATE_COUNTS_INCONSISTENT' };
  }
  if (d.eligible === 0) {
    const reasons = d.ineligible.map((e) => `${e.rows} ${e.reason}`).join(', ');
    return { grade: 'RATE_ELIGIBLE_ZERO', printed: `undefined (0 eligible: ${reasons})` };
  }
  if (d.measured === 0) {
    return {
      grade: 'RATE_UNMEASURED',
      printed: `undefined (0 of ${d.eligible} eligible measured)`,
    };
  }
  const unmeasured = d.eligible - d.measured;
  const value = (numerator / d.measured).toFixed(2);
  return {
    grade: 'RATE_DEFINED',
    printed: unmeasured > 0 ? `${value} (${unmeasured} eligible not measured)` : value,
  };
}

/** Gate first (shape), then the rate check (counts). */
export function read(row, gate) {
  const outcome = gate.ingest(row);
  if (outcome.status !== 'accepted') {
    const missing = outcome.missing ? outcome.missing.join(', ') : '-';
    return { gate: outcome.code, grade: outcome.code, printed: 'refused', missing };
  }
  const { grade, printed } = gradeRate(row);
  return { gate: 'ok', grade, printed: printed ?? 'refused', missing: '-' };
}

/** Merging rows adds every count, the ineligible ones by reason, and divides at the end. */
export function merge(rows) {
  const reasons = new Map();
  let numerator = 0;
  let raw = 0;
  let eligible = 0;
  let measured = 0;
  for (const { numerator: n, denominator: d } of rows) {
    numerator += n;
    raw += d.raw;
    eligible += d.eligible;
    measured += d.measured;
    for (const e of d.ineligible) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + e.rows);
  }
  const ineligible = [...reasons].map(([reason, n]) => ({ reason, rows: n }));
  return { numerator, denominator: { raw, ineligible, eligible, measured } };
}

// --- the fixture ------------------------------------------------------------------------------

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const lines = readFileSync(join(here, 'rate-rows.jsonl'), 'utf8').split('\n').filter(Boolean);
  const gate = new RowGate({ registry, readerSet: RATE_SET, quarantineTtlMs: 60_000 });
  const widths = [5, 26, 26, 38];
  const line = (cells) =>
    `${cells.map((c, i) => (i < widths.length ? String(c).padEnd(widths[i]) : String(c))).join('  ')}\n`;
  process.stdout.write(line(['case', 'gate', 'grade', 'printed', 'missing']));
  let failures = 0;
  const served = [];
  for (const raw of lines) {
    const c = JSON.parse(raw);
    const row = stampRateRow({ id: c.id, runId: 'run_eligible', ...c.row }, c.stampedAs);
    const r = read(row, gate);
    const ok = r.grade === c.expectGrade && r.printed === c.expectPrinted;
    if (!ok) failures += 1;
    if (r.grade === 'RATE_DEFINED') served.push(c.id);
    process.stdout.write(
      line([
        c.id,
        r.gate,
        r.grade + (r.grade === c.expectGrade ? '' : ` != ${c.expectGrade}`),
        r.printed + (r.printed === c.expectPrinted ? '' : ` != ${c.expectPrinted}`),
        r.missing,
      ]),
    );
  }

  // The writer side refuses a rate row with no eligible count at all.
  let refused = 0;
  try {
    stampRateRow({
      id: 'bad',
      runId: 'run_eligible',
      metricId: 'activation',
      variant: 'treatment',
      numerator: 0,
      denominator: { raw: 6, ineligible: [], measured: 6 },
    });
  } catch (err) {
    if (err instanceof ValidationError) refused += 1;
    else throw err;
  }

  // Three shards of one variant, one of them with nothing eligible.
  const shard = (numerator, raw, noOutcome, measured) => ({
    numerator,
    denominator: {
      raw,
      ineligible: noOutcome > 0 ? [{ reason: 'no_outcome', rows: noOutcome }] : [],
      eligible: raw - noOutcome,
      measured,
    },
  });
  const shards = [shard(2, 4, 0, 4), shard(0, 3, 3, 0), shard(1, 3, 1, 2)];
  const merged = gradeRate(merge(shards));
  const zeroFilled = shards.map((s) =>
    s.denominator.measured > 0 ? s.numerator / s.denominator.measured : 0,
  );
  const meanOfRates = (zeroFilled.reduce((a, b) => a + b, 0) / zeroFilled.length).toFixed(2);
  const emptyOnly = gradeRate(merge([shards[1], shards[1]]));
  const mergeOk = merged.printed === '0.50' && emptyOnly.grade === 'RATE_ELIGIBLE_ZERO';

  process.stdout.write(`\nserved as a rate:        ${served.length} (${served.join(', ')})\n`);
  process.stdout.write(`no eligible count refused at stamp: ${refused}/1\n`);
  process.stdout.write(
    `merged shards:           ${merged.printed} (mean of shard rates, empty shard as 0: ${meanOfRates})\n`,
  );
  process.stdout.write(`merged empty shards:     ${emptyOnly.printed}\n`);
  process.stdout.write(`grades as written:       ${lines.length - failures}/${lines.length}\n`);
  if (failures > 0 || refused !== 1 || !mergeOk) {
    process.stderr.write(
      `${failures} case(s) differ from rate-rows.jsonl; stamp refusals ${refused}/1; merge ${mergeOk ? 'ok' : 'wrong'}\n`,
    );
    process.exit(1);
  }
}

main();
