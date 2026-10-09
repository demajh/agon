import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAgonConfig, type AgonConfig } from './config.js';
import { ConflictError } from './errors.js';
import { FindingSchema, closeFinding, requirementsDigest, requirementsOf } from './receipts.js';

const example = readFileSync(new URL('./__fixtures__/agon.example.yaml', import.meta.url), 'utf8');
const env = { PREVIEW_URL: 'https://pr-123.example.app', POSTHOG_SIM_KEY: 'phc_test' };
const config = (): AgonConfig => parseAgonConfig(example, { env });

describe('requirementsDigest', () => {
  it('is deterministic and 64 hex characters', () => {
    const digest = requirementsDigest(config());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(requirementsDigest(config())).toBe(digest);
  });

  it('changes when a metric changes and does not when a variant changes', () => {
    const base = config();
    const digest = requirementsDigest(base);

    const otherMetric = structuredClone(base);
    const first = otherMetric.metrics[0];
    if (first === undefined) throw new Error('fixture has no metrics');
    first.direction = first.direction === 'increase' ? 'decrease' : 'increase';
    expect(requirementsDigest(otherMetric)).not.toBe(digest);

    const otherVariant = structuredClone(base);
    otherVariant.target.variants['treatment'] = {
      ...otherVariant.target.variants['treatment']!,
      url: 'https://pr-999.example.app',
      gitRef: 'deadbeef',
    };
    otherVariant.target.variants['experimental'] = {
      url: 'https://x.example.app',
      env: {},
      headers: {},
    };
    expect(requirementsDigest(otherVariant)).toBe(digest);
  });

  it('changes when the materiality boundary or a policy changes', () => {
    const base = config();
    const digest = requirementsDigest(base);
    const moved = structuredClone(base);
    moved.analysis.materiality.fields.push('metrics.activation');
    expect(requirementsDigest(moved)).not.toBe(digest);
    const policy = structuredClone(base);
    policy.policies = [];
    expect(requirementsDigest(policy)).not.toBe(digest);
    expect(Object.keys(requirementsOf(base)).sort()).toEqual(['analysis', 'metrics', 'policies']);
  });
});

describe('findings', () => {
  const finding = FindingSchema.parse({
    id: 'fnd_1',
    receiptId: 'res_1',
    invariant: 'a refund never exceeds the original charge',
    impact: 'three customers were over-refunded by the variant',
    closureOwner: 'payments-team',
    settlement: { predicate: 'no over-refund in 30 days of live traffic', observer: 'finance-ops' },
    requirementsDigest: 'abc',
    createdAt: '2026-10-09T00:00:00.000Z',
  });

  it('opens with status open and no closedAt, and names its settlement', () => {
    expect(finding.status).toBe('open');
    expect(finding.closedAt).toBeUndefined();
    expect(finding.settlement.observer).toBe('finance-ops');
    expect(() => FindingSchema.parse({ ...finding, closedAt: finding.createdAt })).toThrow(
      /open finding has no closedAt/,
    );
    expect(() => FindingSchema.parse({ ...finding, status: 'closed_fixed' })).toThrow(
      /closed finding needs closedAt/,
    );
  });

  it('closes as fixed or tolerated, once', () => {
    const fixed = closeFinding(finding, 'closed_fixed', '2026-10-10T00:00:00.000Z');
    expect(fixed.status).toBe('closed_fixed');
    expect(fixed.closedAt).toBe('2026-10-10T00:00:00.000Z');
    const tolerated = closeFinding(finding, 'closed_tolerated', '2026-10-10T00:00:00.000Z');
    expect(tolerated.status).toBe('closed_tolerated');
    expect(() => closeFinding(fixed, 'closed_tolerated', '2026-10-11T00:00:00.000Z')).toThrow(
      ConflictError,
    );
  });
});
