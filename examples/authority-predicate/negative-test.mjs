#!/usr/bin/env node
// The authority predicate as a reader-published required set, and the negative test described in
// docs/authority-predicate.md: revoke credential epoch N, leave the fallback N-1 alive, issue
// canaries whose written expected outcome is refusal, and grade any row that comes back as
// AUTHORITY_FALLTHROUGH even when its shape and its watermark pass.
//
// Run after `pnpm build` (it imports the built packages by path, so it needs no package of its own):
//   node examples/authority-predicate/negative-test.mjs
// Exits 1 when a grade differs from the one written in canaries.jsonl.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_REGISTRY,
  REQUIRED_SETS,
  ValidationError,
  checkRow,
  missingFields,
  stampRow,
} from '../../packages/spec/dist/index.js';
import { RowGate } from '../../packages/exporters/dist/index.js';

// --- the reader's registry --------------------------------------------------------------------

/** The three fields of the predicate, dotted like every other path in a required set. */
export const AUTHORITY_FIELDS = [
  'authority',
  'authority.state',
  'authority.expectedId',
  'authority.credentialEpoch',
];
export const AUTHORITY_STATES = ['attested', 'unattested', 'unsupported'];

/** The set this reader relies on: everything `agon.result.1` promises, plus the predicate. */
export const AUTHORITY_SET = 'example.result_authority.1';
const AUTHORITY_SET_VERSION = '2026-10-16.1';

/**
 * The registry is a value the reader hands to the gate, so a reader can publish a set the
 * built-in registry does not have. One generation above the built-in one: a gate restored from
 * an older snapshot replays its quarantine against this registry.
 */
export const registry = {
  generation: CONTRACT_REGISTRY.generation + 1,
  sets: {
    ...REQUIRED_SETS,
    [AUTHORITY_SET]: {
      version: AUTHORITY_SET_VERSION,
      fields: [...REQUIRED_SETS['agon.result.1'].fields, ...AUTHORITY_FIELDS],
    },
  },
};

/** The source side: refuses to stamp a row that lacks a field of the set, like `stampRow`. */
export function stampAuthorityRow(row) {
  const missing = missingFields(row, registry.sets[AUTHORITY_SET].fields);
  if (missing.length > 0) {
    throw new ValidationError(`cannot stamp with ${AUTHORITY_SET}: missing ${missing.join(', ')}`, {
      requiredSet: AUTHORITY_SET,
      missing,
    });
  }
  if (!AUTHORITY_STATES.includes(row.authority.state)) {
    throw new ValidationError(`authority.state must be one of ${AUTHORITY_STATES.join(', ')}`);
  }
  return { ...row, schemaVersion: AUTHORITY_SET_VERSION, requiredSet: AUTHORITY_SET };
}

// --- the credential world the test fixes ------------------------------------------------------

/** Epoch 7 is revoked; the fallback epoch 6 is still alive. That is the hazard under test. */
export const EPOCHS = { authorityId: 'observer:ops-reader', revoked: [7], alive: [6] };

/** What a canary must have written before the read: a refusal under a revoked epoch, a row otherwise. */
export function expectedOutcome(canary) {
  if (canary.authorityId !== EPOCHS.authorityId) {
    throw new ValidationError(
      `canary ${canary.id} names an unknown authority ${canary.authorityId}`,
    );
  }
  if (EPOCHS.revoked.includes(canary.credentialEpoch)) return 'refusal';
  if (EPOCHS.alive.includes(canary.credentialEpoch)) return 'row';
  throw new ValidationError(`canary ${canary.id} names an unknown epoch ${canary.credentialEpoch}`);
}

// --- the grader -------------------------------------------------------------------------------

/**
 * Grades one canary against what came back. The gate runs first and its code is reported beside
 * the grade; a row that lacks the predicate never reaches an authority verdict. Only
 * AUTHORITY_VALID is served.
 */
export function grade(canary, returned, gate) {
  const expected = expectedOutcome(canary);
  if (expected !== canary.expected) {
    throw new ValidationError(
      `canary ${canary.id} wrote "${canary.expected}" but the epoch registry says "${expected}"`,
    );
  }
  if (returned === null) {
    return expected === 'refusal'
      ? { gate: '-', grade: 'REFUSED_AS_EXPECTED', served: false }
      : { gate: '-', grade: 'REFUSED_UNEXPECTEDLY', served: false };
  }
  const outcome = gate.ingest(returned);
  const gateCode = outcome.status === 'accepted' ? 'ok' : outcome.code;
  // Any row at all answers a canary written for refusal: the source, or a fallback behind it,
  // served a read the revoked credential should have stopped.
  if (expected === 'refusal')
    return { gate: gateCode, grade: 'AUTHORITY_FALLTHROUGH', served: false };
  if (outcome.status !== 'accepted') return { gate: gateCode, grade: outcome.code, served: false };
  if (Date.parse(returned.computedAt) < Date.parse(canary.issuedAt)) {
    return { gate: gateCode, grade: 'WATERMARK_STALE', served: false };
  }
  const { state, expectedId, credentialEpoch } = returned.authority;
  if (state !== 'attested')
    return { gate: gateCode, grade: 'SOURCE_READ_UNATTRIBUTED', served: false };
  if (expectedId !== canary.authorityId || credentialEpoch !== canary.credentialEpoch) {
    return { gate: gateCode, grade: 'AUTHORITY_MISMATCH', served: false };
  }
  return { gate: gateCode, grade: 'AUTHORITY_VALID', served: true };
}

// --- the fixture ------------------------------------------------------------------------------

/** A complete `agon.result.1` row; every returned row in the fixture is this shape plus the predicate. */
function resultBody(canaryId, computedAt) {
  return {
    id: `res_${canaryId}`,
    runId: 'run_authority_demo',
    method: 'bayesian',
    control: 'control',
    primaryMetricId: 'activation',
    metrics: [],
    decision: { verdict: 'inconclusive', rationale: 'canary read; no sessions analysed' },
    calibration: { profile: 'default', note: 'forecast; see the calibration note' },
    sessionsAnalyzed: 0,
    computedAt,
    engine: { name: 'agon-stats', version: '0.0.1' },
    kind: 'model',
    assumptions: [],
    requirementsDigest: '0000000000000000',
  };
}

/** Builds the row the source sent: stamped with the set the fixture names. */
function returnedRow(canary, returned) {
  if (returned === null) return null;
  const body = resultBody(canary.id, returned.computedAt);
  if (returned.stampedAs === 'agon.result.1') {
    // Shape-complete by Agon's own writer check: stampRow accepts it without complaint.
    return stampRow('result', body);
  }
  if (returned.stampedAs === AUTHORITY_SET) {
    return stampAuthorityRow({ ...body, authority: returned.authority });
  }
  throw new ValidationError(`canary ${canary.id}: unknown stamp ${returned.stampedAs}`);
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const lines = readFileSync(join(here, 'canaries.jsonl'), 'utf8').split('\n').filter(Boolean);
  const gate = new RowGate({ registry, readerSet: AUTHORITY_SET, quarantineTtlMs: 60_000 });
  const widths = [6, 5, 8, 11, 25, 25];
  const line = (cells) =>
    `${cells.map((c, i) => (i < widths.length ? String(c).padEnd(widths[i]) : String(c))).join('  ')}\n`;
  process.stdout.write(line(['canary', 'epoch', 'expected', 'state', 'gate', 'grade', 'served']));
  let failures = 0;
  const valid = [];
  for (const raw of lines) {
    const { canary, returned, expectGrade } = JSON.parse(raw);
    const row = returnedRow(canary, returned);
    const result = grade(canary, row, gate);
    const ok = result.grade === expectGrade;
    if (!ok) failures += 1;
    if (result.served) valid.push(canary.id);
    process.stdout.write(
      line([
        canary.id,
        canary.credentialEpoch,
        canary.expected,
        row?.authority?.state ?? (row === null ? '(refused)' : '(absent)'),
        result.gate,
        result.grade + (ok ? '' : ` != ${expectGrade}`),
        result.served ? 'yes' : 'no',
      ]),
    );
  }
  const byShape = gate.acceptedKeys().filter((key) => gate.serve(key)?.ok);
  process.stdout.write(`\npassed the gate by shape: ${byShape.length} (${byShape.join(', ')})\n`);
  process.stdout.write(`authority-valid, served:  ${valid.length} (${valid.join(', ')})\n`);
  process.stdout.write(`grades as written:        ${lines.length - failures}/${lines.length}\n`);
  if (failures > 0) {
    process.stderr.write(`${failures} grade(s) differ from canaries.jsonl\n`);
    process.exit(1);
  }
}

main();
