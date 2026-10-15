#!/usr/bin/env node
// Regression case for the results contract (docs/results-contract.md): one immutable, unstamped
// Result row assessed under two named candidate contracts. The case keeps four things apart:
//
//   row         the input, as it was written; a digest pins it
//   declared    what the row says about its own version: nothing, kept as null, never inferred
//   candidates  one conditional assessment per named candidate: pass or fail, with the missing fields
//   inference   a validator's guess, under a named rule, recorded as a guess
//   admission   the consumer's decision for the row: `checkRow` under the reader's set
//
// Run from the repository root after `pnpm install && pnpm -F @agon/spec build`:
//
//   node examples/results-contract/regression.mjs            check against regression-case.json
//   node examples/results-contract/regression.mjs --write    regenerate regression-case.json
//
// Exit code 1 when the recomputed case differs from the committed one or an invariant fails.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  CONTRACT_REGISTRY,
  REQUIRED_SETS,
  ResultSchema,
  UNSTAMPED_REQUIRED_SET,
  canonicalJson,
  checkRow,
  hashValue,
  missingFields,
  readStamp,
} from '@agon/spec';

const here = dirname(fileURLToPath(import.meta.url));
const ROW_PATH = join(here, 'unstamped-result.json');
const CASE_PATH = join(here, 'regression-case.json');

/**
 * The two named candidates. The first is the published `agon.result.1`, read from the registry.
 * The second is a candidate that has not been published: it is `agon.result.1` plus
 * `decision.variant`, for a consumer that needs every result to name a variant. Nothing here
 * edits the registry; the candidate lives only in this case.
 */
const CANDIDATES = [
  {
    candidate: 'agon.result.1',
    version: REQUIRED_SETS['agon.result.1'].version,
    published: true,
    fields: REQUIRED_SETS['agon.result.1'].fields,
  },
  {
    candidate: 'agon.result.2',
    version: '2026-10-15.1',
    published: false,
    fields: [...REQUIRED_SETS['agon.result.1'].fields, 'decision.variant'],
  },
];

/** The reader whose admission decision the case records. */
const READER_SET = 'agon.result.1';

/**
 * Inference rules a validator might use to guess a version for an unstamped row. Each takes the
 * conditional assessments and returns the candidate it would guess, or null. Swapping the rule
 * changes `inference` in the case and nothing else; the regression check below holds that.
 */
const INFERENCE_RULES = {
  'newest-covering-candidate': (assessments) => {
    const passing = assessments.filter((a) => a.pass);
    return passing.length === 0 ? null : passing[passing.length - 1].candidate;
  },
  'oldest-covering-candidate': (assessments) => {
    const passing = assessments.filter((a) => a.pass);
    return passing.length === 0 ? null : passing[0].candidate;
  },
  'never-guess': () => null,
};

function assess(row, candidate) {
  const missing = missingFields(row, candidate.fields);
  return {
    candidate: candidate.candidate,
    version: candidate.version,
    published: candidate.published,
    pass: missing.length === 0,
    missing,
  };
}

/** Builds the case from the row. Pure: the same row and rule give the same case. */
export function buildCase(row, { rule = 'newest-covering-candidate' } = {}) {
  const parsed = ResultSchema.safeParse(row);
  if (!parsed.success) throw new Error(`the row is not a valid Result: ${parsed.error.message}`);
  // The parsed value is discarded on purpose: ResultSchema fills defaults, and a default is an
  // inference. The row is assessed exactly as it was stored.

  const stamp = readStamp(row);
  const assessments = CANDIDATES.map((candidate) => assess(row, candidate));
  const admission = checkRow(row, READER_SET, CONTRACT_REGISTRY);

  return {
    case: 'unstamped-result-under-two-candidates',
    row,
    rowDigest: hashValue(row),
    declared: {
      schemaVersion: stamp?.schemaVersion ?? null,
      requiredSet: stamp?.requiredSet ?? null,
    },
    candidates: assessments,
    inference: {
      rule,
      guess: INFERENCE_RULES[rule](assessments),
      note: 'A guess about the row, not a statement by it and not an admission.',
    },
    admission: {
      reader: READER_SET,
      registryGeneration: CONTRACT_REGISTRY.generation,
      admitted: admission.ok,
      code: admission.ok ? null : admission.code,
      requiredSet: admission.requiredSet,
    },
  };
}

/** What must hold whatever the inference rule says. */
function checkInvariants(built, row) {
  const failures = [];
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
  };

  expect(canonicalJson(built.row) === canonicalJson(row), 'the row was rewritten');
  expect(built.rowDigest === hashValue(row), 'the row digest moved');
  expect(built.declared.schemaVersion === null, 'a declared schemaVersion appeared');
  expect(built.declared.requiredSet === null, 'a declared requiredSet appeared');
  expect(!('schemaVersion' in built.row), 'schemaVersion was written into the row');
  expect(!('requiredSet' in built.row), 'requiredSet was written into the row');
  expect(built.candidates.length === 2, 'the case must assess exactly two candidates');
  expect(
    built.candidates.every((a) => typeof a.candidate === 'string' && typeof a.pass === 'boolean'),
    'every assessment names its candidate and says pass or fail',
  );
  expect(built.admission.admitted === false, 'an unstamped row was admitted');
  expect(
    built.admission.code === 'REQUIRED_SET_UNRESOLVED',
    `admission code is ${built.admission.code}, expected REQUIRED_SET_UNRESOLVED`,
  );
  expect(
    built.admission.requiredSet === UNSTAMPED_REQUIRED_SET,
    `admission requiredSet is ${built.admission.requiredSet}, expected ${UNSTAMPED_REQUIRED_SET}`,
  );

  // Changing the inference rule may change the guess. It must not touch anything else.
  const baseline = { ...built, inference: null };
  for (const rule of Object.keys(INFERENCE_RULES)) {
    const other = buildCase(row, { rule });
    expect(
      canonicalJson({ ...other, inference: null }) === canonicalJson(baseline),
      `inference rule ${rule} changed something other than the guess`,
    );
    expect(
      other.admission.admitted === false,
      `inference rule ${rule} turned a guess into an admission`,
    );
  }
  return failures;
}

async function main() {
  const write = process.argv.includes('--write');
  const row = JSON.parse(await readFile(ROW_PATH, 'utf8'));
  const built = buildCase(row);
  const failures = checkInvariants(built, row);
  const rel = (p) => relative(process.cwd(), p);

  if (failures.length > 0) {
    for (const f of failures) console.error(`invariant failed: ${f}`);
    process.exit(1);
  }

  if (write) {
    await writeFile(CASE_PATH, `${JSON.stringify(built, null, 2)}\n`);
    console.log(`wrote ${rel(CASE_PATH)}`);
    return;
  }

  let committed;
  try {
    committed = JSON.parse(await readFile(CASE_PATH, 'utf8'));
  } catch (error) {
    console.error(`cannot read ${rel(CASE_PATH)}: ${String(error)}; run with --write`);
    process.exit(1);
  }

  if (canonicalJson(committed) !== canonicalJson(built)) {
    console.error(`${rel(CASE_PATH)} differs from the case recomputed from ${rel(ROW_PATH)}`);
    for (const key of Object.keys(built)) {
      if (canonicalJson(committed[key]) !== canonicalJson(built[key])) {
        console.error(`  ${key}: committed ${canonicalJson(committed[key])}`);
        console.error(`  ${key}: recomputed ${canonicalJson(built[key])}`);
      }
    }
    process.exit(1);
  }

  for (const a of built.candidates) {
    const outcome = a.pass ? 'pass' : `fail (missing ${a.missing.join(', ')})`;
    console.log(`${a.candidate} (${a.version}${a.published ? '' : ', candidate'}): ${outcome}`);
  }
  console.log(`declared: ${JSON.stringify(built.declared)}`);
  console.log(`inference (${built.inference.rule}): ${built.inference.guess}`);
  console.log(
    `admission under ${built.admission.reader}: ${built.admission.admitted ? 'admitted' : 'refused'} ${built.admission.code} ${built.admission.requiredSet}`,
  );
  console.log(`ok: ${rel(CASE_PATH)} matches`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
