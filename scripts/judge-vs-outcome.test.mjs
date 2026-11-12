// Exercises scripts/judge-vs-outcome.mjs on run directories written here in the JSONL sink's shape.
// The sessions are constructed for the test and are not measurements.
// Run with `node --test scripts/judge-vs-outcome.test.mjs`; needs no build.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { countRun, render, report, wilson } from './judge-vs-outcome.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), 'judge-vs-outcome-'));
after(() => rmSync(out, { recursive: true, force: true }));

const judgement = (success, satisfaction = 4) => ({
  success,
  satisfaction,
  frustration: 2,
  confidence: 0.8,
  summary: success ? 'Looked done.' : 'Did not finish.',
});

function writeRun(id, { model, judgeModel, scenarios, sessions }) {
  const dir = join(out, id);
  mkdirSync(dir, { recursive: true });
  const defaults = judgeModel === undefined ? { model } : { model, judgeModel };
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({ id, startedAt: '2026-01-02T03:04:05.000Z', config: { scenarios, defaults } }),
  );
  writeFileSync(
    join(dir, 'sessions.jsonl'),
    sessions
      .map((s, index) => JSON.stringify({ id: `ses_${id}_${index}`, scenarioId: 'anchored', ...s }))
      .join('\n'),
  );
  return dir;
}

const SCENARIOS = [
  { id: 'anchored', success: { type: 'event', name: 'project_created' } },
  { id: 'checked', success: { type: 'check', command: 'true' } },
  { id: 'judged', success: { type: 'judge' } },
];

const live = writeRun('run_live', {
  model: 'anthropic/some-model',
  scenarios: SCENARIOS,
  sessions: [
    { outcome: 'success', judgement: judgement(true) },
    { outcome: 'success', judgement: judgement(true, 3) },
    { outcome: 'gave_up', outcomeReason: 'state check failed', judgement: judgement(true, 5) },
    { scenarioId: 'checked', outcome: 'max_steps', judgement: judgement(true, 3) },
    { outcome: 'success', judgement: judgement(false) },
    { outcome: 'gave_up', judgement: judgement(false) },
    { outcome: 'success' },
    { status: 'failed', error: 'run time cap reached' },
    { scenarioId: 'judged', outcome: 'success', judgement: judgement(true) },
  ],
});

writeRun('run_scripted', {
  model: 'anthropic/some-model',
  judgeModel: 'fake/model-1',
  scenarios: SCENARIOS,
  sessions: [{ outcome: 'gave_up', judgement: judgement(true) }],
});

describe('judge-vs-outcome', () => {
  it('counts only judged sessions with an anchored outcome', () => {
    const { counts, disagreements, date, judgeModel } = countRun(live);
    assert.deepEqual(counts, {
      sessions: 9,
      judgeDecided: 1,
      noOutcome: 1,
      anchoredOutcome: 7,
      notJudged: 1,
      judged: 6,
      judgeHigh: 4,
      judgeHighOutcomeFailed: 2,
      judgeLow: 2,
      judgeLowOutcomePassed: 1,
    });
    assert.deepEqual(
      disagreements.map((d) => d.outcome),
      ['gave_up', 'max_steps'],
    );
    assert.equal(date, '2026-01-02');
    assert.equal(judgeModel, 'anthropic/some-model');
  });

  it('narrows rated high with a satisfaction floor', () => {
    const { counts } = countRun(live, 4);
    assert.equal(counts.judgeHigh, 2);
    assert.equal(counts.judgeHighOutcomeFailed, 1);
    assert.equal(counts.judgeLow, 4);
  });

  it('leaves a scripted judge out of the total and calls a small sample small', () => {
    const r = report([out]);
    assert.equal(r.runsRead, 2);
    assert.equal(r.runsCounted, 1);
    assert.equal(r.total.judgeHigh, 4);
    assert.equal(r.total.judgeHighOutcomeFailed, 2);
    assert.equal(r.disagreementRate, 0.5);
    assert.equal(r.sample, 'small');
    const text = render(r);
    assert.match(text, /2 of 4 \(50\.0%/);
    assert.match(text, /Small sample: 4 rated-high session\(s\)/);
    assert.match(text, /no \(scripted judge\)/);
  });

  it('prints undefined, not 0%, over the committed fixture, which has no judgements', () => {
    const r = report([join(REPO_ROOT, 'examples', 'run-report')]);
    assert.equal(r.runsCounted, 0);
    assert.equal(r.disagreementRate, null);
    assert.equal(r.sample, 'none');
    assert.match(render(r), /undefined \(0 of 0\)\. No sample/);
  });

  it('computes the Wilson interval', () => {
    assert.equal(wilson(0, 0), null);
    const { low, high } = wilson(2, 4);
    assert.ok(Math.abs(low - 0.15) < 0.005 && Math.abs(high - 0.85) < 0.005);
  });
});
