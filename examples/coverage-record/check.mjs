#!/usr/bin/env node
// Checks the synthetic coverage record, derives the verdict of every source from set
// membership alone, compares the derivation with expected-verdicts.json, and grades a reader's
// answers. No dependencies; Node >= 22.
//
//   node examples/coverage-record/check.mjs                      # validate + derive + compare
//   node examples/coverage-record/check.mjs --answers file.json  # also grade a reader's answers
//   node examples/coverage-record/check.mjs --json               # machine-readable output
//
// Exit 0 when the record is well formed, the derivation matches the key and (if given) the
// answers match the key; 1 otherwise.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const json = args.includes('--json');
const answersIndex = args.indexOf('--answers');
const answersPath = answersIndex === -1 ? undefined : args[answersIndex + 1];
const recordPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--answers');

const VERDICTS = ['covered', 'excluded_explained', 'selection_dispute', 'capture_failure'];
const RANK = { covered: 0, excluded_explained: 1, selection_dispute: 2, capture_failure: 3 };

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Structural checks. Returns a list of problems; an empty list means the record is well formed. */
function validate(record) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (record.kind !== 'coverage-record') fail('kind must be "coverage-record"');
  if (!record.observer || !Array.isArray(record.observer.message)) {
    fail('observer.message must be a list of lines');
  }
  if (!record.original || !isString(record.original.asOf)) fail('original.asOf is required');

  const batches = [
    { label: 'original', date: record.original?.asOf, sets: record.original ?? {} },
    ...(record.revisions ?? []).map((r, i) => ({ label: `revision[${i}]`, date: r.date, sets: r })),
  ];

  // Dated additions only: each batch is dated, in order, and introduces only new ids.
  let lastDate = '';
  const seen = { nominated: new Set(), selected: new Set(), received: new Set() };
  for (const batch of batches) {
    if (!isString(batch.date)) fail(`${batch.label}: a date is required`);
    else if (batch.date < lastDate) fail(`${batch.label}: dated ${batch.date}, before ${lastDate}`);
    lastDate = batch.date ?? lastDate;
    if (batch.label !== 'original' && !isString(batch.sets.by))
      fail(`${batch.label}: by is required`);

    for (const set of ['nominated', 'selected', 'received']) {
      const entries = batch.sets[set];
      if (!Array.isArray(entries)) {
        fail(`${batch.label}: ${set} must be a list`);
        continue;
      }
      for (const entry of entries) {
        const where = `${batch.label}.${set} ${entry.id ?? '(no id)'}`;
        if (!isString(entry.id)) fail(`${where}: id is required`);
        if (seen[set].has(entry.id)) {
          fail(`${where}: already present; a revision adds entries, it never rewrites one`);
        }
        seen[set].add(entry.id);
        if (set === 'nominated') {
          if (!isString(entry.proposedBy)) fail(`${where}: proposedBy is required`);
          if (!isString(entry.why)) fail(`${where}: why (the reason it was proposed) is required`);
        }
        if (set === 'selected') {
          if (!seen.nominated.has(entry.id)) fail(`${where}: selected but never nominated`);
          if (!isString(entry.by)) fail(`${where}: by is required`);
          if (typeof entry.included !== 'boolean') fail(`${where}: included must be a boolean`);
          if (!('why' in entry))
            fail(`${where}: why must be present (a string, or null when unrecorded)`);
          else if (entry.why !== null && !isString(entry.why))
            fail(`${where}: why must be a string or null`);
          if (entry.included && entry.why === null) fail(`${where}: an inclusion needs a reason`);
        }
        if (set === 'received') {
          if (!seen.selected.has(entry.id)) fail(`${where}: received but never selected`);
          if (!isString(entry.by)) fail(`${where}: by is required`);
          if (!['usable', 'unusable', 'missing'].includes(entry.status)) {
            fail(`${where}: status must be usable, unusable or missing`);
          }
          if (entry.status === 'missing' && entry.receivedAt !== null) {
            fail(`${where}: a missing source has receivedAt null`);
          }
          if (entry.status !== 'missing' && !isString(entry.receivedAt)) {
            fail(`${where}: receivedAt is required unless the source is missing`);
          }
          if (!isString(entry.detail)) fail(`${where}: detail is required`);
        }
      }
    }
    for (const note of batch.sets.annotations ?? []) {
      if (!seen.nominated.has(note.id))
        fail(`${batch.label}: annotation on unknown source ${note.id}`);
      if (!isString(note.text)) fail(`${batch.label}: annotation on ${note.id} needs text`);
    }
  }

  for (const id of seen.nominated) {
    if (!seen.selected.has(id)) fail(`${id}: nominated but no selection decision recorded`);
  }
  return problems;
}

/** The verdict of every nominated source, from set membership alone. */
function derive(record) {
  const batches = [
    { date: record.original.asOf, sets: record.original },
    ...(record.revisions ?? []).map((r) => ({ date: r.date, sets: r })),
  ];
  const asOf = new Map();
  const selected = new Map();
  const received = new Map();
  for (const batch of batches) {
    for (const n of batch.sets.nominated ?? []) asOf.set(n.id, batch.date);
    for (const s of batch.sets.selected ?? []) selected.set(s.id, s);
    for (const r of batch.sets.received ?? []) received.set(r.id, r);
  }

  const sources = {};
  for (const [id, date] of asOf) {
    const s = selected.get(id);
    const r = received.get(id);
    let verdict;
    if (!s.included) verdict = s.why === null ? 'selection_dispute' : 'excluded_explained';
    else if (r && r.status === 'usable') verdict = 'covered';
    else verdict = 'capture_failure';
    sources[id] = { verdict, asOf: date };
  }
  const overall = Object.values(sources)
    .map((s) => s.verdict)
    .reduce((worst, v) => (RANK[v] > RANK[worst] ? v : worst), 'covered');
  return { sources, overall };
}

/** The record must contain the two cases the reader test is about. */
function requiredCases(derived) {
  const verdicts = Object.values(derived.sources).map((s) => s.verdict);
  const problems = [];
  if (!verdicts.includes('selection_dispute')) {
    problems.push('the record has no nominated source excluded without an explanation');
  }
  if (!verdicts.includes('capture_failure')) {
    problems.push('the record has no selected source that never arrived');
  }
  return problems;
}

function compareWithKey(derived, key) {
  const mismatches = [];
  const ids = new Set([...Object.keys(derived.sources), ...Object.keys(key.sources)]);
  for (const id of ids) {
    const d = derived.sources[id];
    const k = key.sources[id];
    if (!d) mismatches.push(`${id}: in the key but not in the record`);
    else if (!k) mismatches.push(`${id}: in the record but not in the key`);
    else if (d.verdict !== k.verdict) {
      mismatches.push(`${id}: the sets say ${d.verdict}, the key says ${k.verdict}`);
    } else if (d.asOf !== k.asOf) {
      mismatches.push(`${id}: the sets date it ${d.asOf}, the key says ${k.asOf}`);
    }
  }
  if (derived.overall !== key.overall.verdict) {
    mismatches.push(
      `overall: the sets say ${derived.overall}, the key says ${key.overall.verdict}`,
    );
  }
  for (const v of Object.values(key.vocabulary ?? {})) {
    if (!isString(v)) mismatches.push('vocabulary entries must be strings');
  }
  for (const v of Object.keys(key.vocabulary ?? {})) {
    if (!VERDICTS.includes(v)) mismatches.push(`vocabulary names an unknown verdict ${v}`);
  }
  return mismatches;
}

function grade(answers, key) {
  const items = [];
  for (const [id, expected] of Object.entries(key.sources)) {
    const given = answers.sources?.[id];
    const trap = (key.traps ?? []).find((t) => t.source === id && t.wrong === given);
    items.push({
      source: id,
      expected: expected.verdict,
      given: given ?? null,
      pass: given === expected.verdict,
      because: expected.because,
      ...(trap ? { trap: trap.whyWrong } : {}),
    });
  }
  const overallTrap = (key.traps ?? []).find(
    (t) => t.source === 'overall' && t.wrong === answers.overall,
  );
  items.push({
    source: 'overall',
    expected: key.overall.verdict,
    given: answers.overall ?? null,
    pass: answers.overall === key.overall.verdict,
    because: key.overall.because,
    ...(overallTrap ? { trap: overallTrap.whyWrong } : {}),
  });
  return items;
}

const record = load(recordPath ? resolve(recordPath) : resolve(here, 'coverage-record.json'));
const key = load(resolve(here, 'expected-verdicts.json'));

const problems = validate(record);
const derived = problems.length ? { sources: {}, overall: null } : derive(record);
const missingCases = problems.length ? [] : requiredCases(derived);
const mismatches = problems.length ? [] : compareWithKey(derived, key);
const graded = answersPath ? grade(load(resolve(answersPath)), key) : undefined;
const failed = graded ? graded.filter((g) => !g.pass) : [];
const ok =
  problems.length === 0 &&
  missingCases.length === 0 &&
  mismatches.length === 0 &&
  failed.length === 0;

if (json) {
  console.log(
    JSON.stringify(
      {
        ok,
        problems,
        missingCases,
        derived,
        mismatches,
        observerMessageIntact: record.observer?.intact ?? null,
        graded,
      },
      null,
      2,
    ),
  );
} else {
  const subject = record.subject ?? {};
  console.log(`coverage record for ${subject.resultId ?? '?'} (${subject.verdict ?? '?'})`);
  console.log(
    `observer: ${record.observer?.name ?? '?'}, message intact: ${record.observer?.intact}; ` +
      'the derivation below never reads it',
  );
  console.log();
  if (problems.length) {
    console.log('record problems:');
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    const width = Math.max(...Object.keys(derived.sources).map((id) => id.length));
    for (const [id, s] of Object.entries(derived.sources)) {
      console.log(`  ${id.padEnd(width)}  ${s.verdict.padEnd(18)} as of ${s.asOf}`);
    }
    console.log(`  ${'overall'.padEnd(width)}  ${derived.overall}`);
    console.log();
    for (const m of missingCases) console.log(`  missing case: ${m}`);
    if (mismatches.length) {
      console.log('key does not match the sets:');
      for (const m of mismatches) console.log(`  - ${m}`);
    } else {
      console.log('expected-verdicts.json agrees with the sets.');
    }
  }
  if (graded) {
    console.log();
    console.log(
      `grading ${answersPath}: ${graded.length - failed.length}/${graded.length} correct`,
    );
    for (const g of failed) {
      console.log(`  ✗ ${g.source}: gave ${g.given}, expected ${g.expected}`);
      console.log(`      ${g.because}`);
      if (g.trap) console.log(`      trap: ${g.trap}`);
    }
  }
}

process.exit(ok ? 0 : 1);
