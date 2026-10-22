#!/usr/bin/env node
// The subject under test as a reader-published required set, and the staleness check described
// in docs/results-contract.md: every result row names, per variant, the commit the app was built
// from and the sha256 of the artifact the run exercised; a reader compares those with the build it
// would act on today and serves the result as current only when every variant's digest matches.
//
// Run after `pnpm build` (it imports the built packages by path, so it needs no package of its own):
//   node examples/subject-digest/stale-check.mjs
// Exits 1 when a grade differs from the one written in cases.jsonl.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_REGISTRY,
  REQUIRED_SETS,
  ValidationError,
  missingFields,
  sha256Hex,
  stampRow,
} from '../../packages/spec/dist/index.js';
import { RowGate } from '../../packages/exporters/dist/index.js';

// --- the reader's registry --------------------------------------------------------------------

/** One entry per variant the run exercised; the list itself is the required field. */
export const SUBJECT_FIELDS = ['subjects'];

/** The set this reader relies on: everything `agon.result.1` promises, plus the subjects. */
export const SUBJECT_SET = 'example.result_subject.1';
const SUBJECT_SET_VERSION = '2026-10-21.1';

export const registry = {
  generation: CONTRACT_REGISTRY.generation + 1,
  sets: {
    ...REQUIRED_SETS,
    [SUBJECT_SET]: {
      version: SUBJECT_SET_VERSION,
      fields: [...REQUIRED_SETS['agon.result.1'].fields, ...SUBJECT_FIELDS],
    },
  },
};

const COMMIT_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** What a build is known by: the bytes, hashed. The commit is where they came from. */
export function artifactDigest(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * The writer side: refuses to stamp a row that lacks the subjects, that leaves a variant of the
 * run without one, or whose commit or digest is not a resolved value (a branch name, a tag or a
 * CI build number is not).
 */
export function stampSubjectRow(row, runVariants) {
  const missing = missingFields(row, registry.sets[SUBJECT_SET].fields);
  if (missing.length > 0) {
    throw new ValidationError(`cannot stamp with ${SUBJECT_SET}: missing ${missing.join(', ')}`, {
      requiredSet: SUBJECT_SET,
      missing,
    });
  }
  const named = new Set(row.subjects.map((s) => s.variant));
  const uncovered = runVariants.filter((v) => !named.has(v));
  if (uncovered.length > 0) {
    throw new ValidationError(`no subject for variant(s) ${uncovered.join(', ')}`);
  }
  for (const s of row.subjects) {
    if (!COMMIT_RE.test(s.commitSha)) {
      throw new ValidationError(`${s.variant}: commitSha must be a full 40-hex commit`);
    }
    if (!DIGEST_RE.test(s.artifactDigest)) {
      throw new ValidationError(`${s.variant}: artifactDigest must be sha256:<64 hex>`);
    }
  }
  return { ...row, schemaVersion: SUBJECT_SET_VERSION, requiredSet: SUBJECT_SET };
}

// --- the staleness check ----------------------------------------------------------------------

/**
 * Grades one row against the build the reader would act on now (`current`: variant ->
 * { commitSha, artifactDigest | null }). The gate runs first; a row without subjects never
 * reaches a freshness verdict. Only SUBJECT_CURRENT is served as a current pass.
 */
export function grade(row, current, gate) {
  const outcome = gate.ingest(row);
  const gateCode = outcome.status === 'accepted' ? 'ok' : outcome.code;
  if (outcome.status !== 'accepted') {
    return { gate: gateCode, grade: outcome.code, reason: '-', served: false };
  }
  const reasons = [];
  let verdict = 'SUBJECT_CURRENT';
  for (const s of row.subjects) {
    const now = current[s.variant];
    if (now === undefined) {
      reasons.push(`${s.variant}: not in the current build`);
      if (verdict !== 'SUBJECT_STALE') verdict = 'SUBJECT_UNVERIFIABLE';
      continue;
    }
    if (now.artifactDigest === null) {
      reasons.push(`${s.variant}: current digest unknown`);
      if (verdict !== 'SUBJECT_STALE') verdict = 'SUBJECT_UNVERIFIABLE';
      continue;
    }
    if (now.artifactDigest !== s.artifactDigest) {
      reasons.push(
        now.commitSha === s.commitSha
          ? `${s.variant}: same commit, other bytes`
          : `${s.variant}: digest moved`,
      );
      // Stale outranks unverifiable: one variant known to have moved is enough.
      verdict = 'SUBJECT_STALE';
      continue;
    }
    if (now.commitSha !== s.commitSha) reasons.push(`${s.variant}: commit moved, same bytes`);
  }
  return {
    gate: gateCode,
    grade: verdict,
    reason: reasons.length > 0 ? reasons.join('; ') : '-',
    served: verdict === 'SUBJECT_CURRENT',
  };
}

// --- the fixture ------------------------------------------------------------------------------

/** A complete `agon.result.1` row; every case is this shape plus, for most, the subjects. */
function resultBody(id, verdict) {
  return {
    id,
    runId: `run_${id}`,
    method: 'bayesian',
    control: 'control',
    primaryMetricId: 'activation',
    metrics: [],
    decision: { verdict, variant: 'treatment', rationale: 'fixture row; no sessions analysed' },
    calibration: { profile: 'default', note: 'forecast; see the calibration note' },
    sessionsAnalyzed: 0,
    computedAt: '2026-10-21T09:00:00Z',
    engine: { name: 'agon-stats', version: '0.0.1' },
    kind: 'model',
    assumptions: [],
    requirementsDigest: '0000000000000000',
  };
}

/** The subjects of a list of build ids; a build with `bytes: null` has no known digest. */
function subjectsOf(buildIds, builds) {
  return buildIds.map((id) => {
    const b = builds[id];
    if (b === undefined) throw new ValidationError(`unknown build ${id}`);
    return {
      variant: b.variant,
      commitSha: b.commitSha,
      artifactDigest: b.bytes === null ? null : artifactDigest(b.bytes),
    };
  });
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const builds = JSON.parse(readFileSync(join(here, 'builds.json'), 'utf8'));
  const lines = readFileSync(join(here, 'cases.jsonl'), 'utf8').split('\n').filter(Boolean);
  const gate = new RowGate({ registry, readerSet: SUBJECT_SET, quarantineTtlMs: 60_000 });
  const widths = [5, 9, 25, 25, 6];
  const line = (cells) =>
    `${cells.map((c, i) => (i < widths.length ? String(c).padEnd(widths[i]) : String(c))).join('  ')}\n`;
  process.stdout.write(line(['case', 'verdict', 'gate', 'grade', 'served', 'reason']));
  let failures = 0;
  const served = [];
  for (const raw of lines) {
    const c = JSON.parse(raw);
    const body = resultBody(c.id, c.verdict);
    const row =
      c.stampedAs === 'agon.result.1'
        ? stampRow('result', body)
        : stampSubjectRow({ ...body, subjects: subjectsOf(c.tested, builds) }, [
            'control',
            'treatment',
          ]);
    const current = Object.fromEntries(
      subjectsOf(c.current, builds).map(({ variant, ...s }) => [variant, s]),
    );
    const result = grade(row, current, gate);
    const ok = result.grade === c.expectGrade;
    if (!ok) failures += 1;
    if (result.served) served.push(c.id);
    process.stdout.write(
      line([
        c.id,
        c.verdict,
        result.gate,
        result.grade + (ok ? '' : ` != ${c.expectGrade}`),
        result.served ? 'yes' : 'no',
        result.reason,
      ]),
    );
  }

  // The writer side refuses a subject that is a name rather than a resolved value.
  let refused = 0;
  for (const bad of [
    { variant: 'control', commitSha: 'main', artifactDigest: artifactDigest('x') },
    { variant: 'control', commitSha: 'a'.repeat(40), artifactDigest: 'build-1842' },
  ]) {
    try {
      stampSubjectRow({ ...resultBody('bad', 'ship'), subjects: [bad] }, ['control']);
    } catch (err) {
      if (err instanceof ValidationError) refused += 1;
      else throw err;
    }
  }

  const byShape = gate.acceptedKeys().filter((key) => gate.serve(key)?.ok);
  process.stdout.write(`\npassed the gate by shape: ${byShape.length} (${byShape.join(', ')})\n`);
  process.stdout.write(`current, served:          ${served.length} (${served.join(', ')})\n`);
  process.stdout.write(`unresolved subjects refused at stamp: ${refused}/2\n`);
  process.stdout.write(`grades as written:        ${lines.length - failures}/${lines.length}\n`);
  if (failures > 0 || refused !== 2) {
    process.stderr.write(
      `${failures} grade(s) differ from cases.jsonl; ${2 - refused} bad stamp(s) accepted\n`,
    );
    process.exit(1);
  }
}

main();
