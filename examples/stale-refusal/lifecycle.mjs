#!/usr/bin/env node
// The three-state lifecycle of a stale refusal described in docs/stale-refusal.md:
// retroactive_execute, lazy_recheck (the default) and human_review. Each case in refusals.jsonl
// is a past "no", the inputs it was decided on, and what happened afterwards; the script replays
// the events, re-runs the rule that refused whenever the lifecycle allows a release, emits one
// audit record per transition, and compares the final outcome with the one written in the case.
//
// Run after `pnpm build` (it imports @agon/spec from its built dist/ by path):
//   node examples/stale-refusal/lifecycle.mjs           one line per case
//   node examples/stale-refusal/lifecycle.mjs --audit   the audit records as JSONL
// Exits 1 when an outcome or a releaser differs from the one written in refusals.jsonl.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateProtectedPaths, hashValue } from '../../packages/spec/dist/index.js';

// --- the rules --------------------------------------------------------------------------------

/**
 * Each rule judges a request against the inputs it reads, at a given time, and says why. The
 * firmware rule is Agon's own `protected_paths` gate; the other two are stand-ins.
 */
const RULES = {
  'transfer.funds@3': (request, inputs) => {
    if (inputs.blockedPayees.includes(request.to)) {
      return { ok: false, reason: `payee ${request.to} is blocked` };
    }
    return inputs.balance >= request.amount
      ? { ok: true, reason: `balance ${inputs.balance} covers ${request.amount}` }
      : { ok: false, reason: `balance ${inputs.balance} is below ${request.amount}` };
  },
  'firmware-images': (request, inputs) => {
    const verdict = evaluateProtectedPaths(inputs.policy, request);
    return {
      ok: !verdict.blocked,
      reason: verdict.reason,
      ...(verdict.approval ? { approvedBy: verdict.approval.approvedBy } : {}),
    };
  },
  'access.prod-read@1': (request, inputs, at) => {
    if (inputs.sponsor === null) return { ok: false, reason: 'no sponsor on record' };
    if (inputs.contractEndsAt <= at) {
      return { ok: false, reason: `contract ended ${inputs.contractEndsAt}` };
    }
    return {
      ok: true,
      reason: `sponsored by ${inputs.sponsor}, contract to ${inputs.contractEndsAt}`,
    };
  },
};

// --- the lifecycle ----------------------------------------------------------------------------

export const LIFECYCLES = ['retroactive_execute', 'lazy_recheck', 'human_review'];

/** What was rechecked: every input the rule reads, its digest at the refusal and now. */
function rechecked(atRefusal, now) {
  return Object.keys(now)
    .sort()
    .map((input) => {
      const then = hashValue(atRefusal[input]).slice(0, 12);
      const current = hashValue(now[input]).slice(0, 12);
      return { input, then, now: current, changed: then !== current };
    });
}

/** Replays one case and returns its final state and the audit records it emitted. */
export function replay(c) {
  const rule = RULES[c.rule];
  if (!rule) throw new Error(`${c.case}: unknown rule ${c.rule}`);
  if (!LIFECYCLES.includes(c.lifecycle)) throw new Error(`${c.case}: unknown lifecycle`);
  const requestDigest = hashValue(c.request).slice(0, 12);
  const first = rule(c.request, c.inputs, c.refusedAt);
  if (first.ok) throw new Error(`${c.case}: the rule does not refuse the request at refusedAt`);

  const audit = [];
  const record = (at, event, extra) =>
    audit.push({
      refusal: c.case,
      event,
      at,
      rule: c.rule,
      refusedAt: c.refusedAt,
      refusedBecause: first.reason,
      lifecycle: c.lifecycle,
      request: requestDigest,
      ...extra,
    });
  record(c.refusedAt, 'refused', { expiresAt: c.expiresAt });

  let inputs = structuredClone(c.inputs);
  let state = { outcome: 'refused', releasedBy: null };

  /** Re-run the rule on the inputs as they are now; release only on a yes. */
  const recheck = (at, releaser, trigger) => {
    const verdict = rule(c.request, inputs, at);
    const releasedBy = verdict.ok ? releaser(verdict) : null;
    record(at, verdict.ok ? 'released' : 'rechecked', {
      trigger,
      rechecked: rechecked(c.inputs, inputs),
      verdict: verdict.ok ? 'yes' : 'no',
      reason: verdict.reason,
      releasedBy,
    });
    if (verdict.ok) state = { outcome: 'executed', releasedBy };
  };

  for (const e of [...c.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (state.outcome !== 'refused') break;
    if (e.at >= c.expiresAt) {
      record(e.at, 'expired', { trigger: e.type });
      state = { outcome: 'expired', releasedBy: null };
      break;
    }
    if (e.type === 'inputs') {
      inputs = { ...inputs, ...e.inputs };
      // Only the retroactive lifecycle acts on an input change; it is the only one with a
      // standing instruction to act on.
      if (c.lifecycle === 'retroactive_execute') {
        recheck(e.at, () => `standing:${c.request.standingBy}`, `inputs:${e.source}`);
      }
    } else if (e.type === 'retry') {
      if (hashValue(e.request).slice(0, 12) !== requestDigest) {
        // A different request is judged on its own; it never releases this refusal.
        const fresh = rule(e.request, inputs, e.at);
        record(e.at, 'new_request', {
          trigger: 'retry',
          retried: hashValue(e.request).slice(0, 12),
          verdict: fresh.ok ? 'yes' : 'no',
          reason: fresh.reason,
        });
        state = { outcome: 'new_request', releasedBy: null };
      } else if (c.lifecycle === 'human_review') {
        record(e.at, 'held', { trigger: 'retry', reason: 'waiting for a reviewer' });
      } else {
        recheck(
          e.at,
          (v) => (v.approvedBy ? `approval:${v.approvedBy}` : `retry:${requestDigest}`),
          'retry',
        );
      }
    } else if (e.type === 'review') {
      if (c.lifecycle !== 'human_review') throw new Error(`${c.case}: review outside the queue`);
      if (e.by === c.request.requestedBy) {
        record(e.at, 'held', { trigger: 'review', reason: `${e.by} may not review own request` });
      } else if (e.decision === 'reject') {
        record(e.at, 'rejected', { trigger: 'review', releasedBy: null, reviewer: e.by });
        state = { outcome: 'rejected', releasedBy: null };
      } else {
        recheck(e.at, () => `reviewer:${e.by}`, `review:${e.by}`);
      }
    } else {
      throw new Error(`${c.case}: unknown event ${e.type}`);
    }
  }
  return { ...state, audit };
}

// --- the runner -------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const cases = readFileSync(join(here, 'refusals.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const results = cases.map((c) => ({ c, ...replay(c) }));

if (process.argv.includes('--audit')) {
  for (const r of results) for (const a of r.audit) console.log(JSON.stringify(a));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `${pad('case', 23)}${pad('lifecycle', 21)}${pad('outcome', 13)}${pad('released by', 20)}as written`,
  );
  for (const r of results) {
    const asWritten =
      r.outcome === r.c.expect.outcome && r.releasedBy === r.c.expect.releasedBy ? 'yes' : 'NO';
    console.log(
      `${pad(r.c.case, 23)}${pad(r.c.lifecycle, 21)}${pad(r.outcome, 13)}${pad(r.releasedBy ?? '-', 20)}${asWritten}`,
    );
  }
}

const failed = results.filter(
  (r) => r.outcome !== r.c.expect.outcome || r.releasedBy !== r.c.expect.releasedBy,
);
if (!process.argv.includes('--audit')) {
  console.log(`\noutcomes as written: ${results.length - failed.length}/${results.length}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
