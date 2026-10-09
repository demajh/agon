import { AgonConfigSchema } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../fakes/config.js';
import { resolvePersonas } from '../population/personas.js';
import { canonicalJson, sampleHash, sampleIdentity, variantKey } from './sample-hash.js';

function hashOf(overrides: Parameters<typeof testConfig>[0] = {}, seed = 42, size = 4): string {
  const config = testConfig(overrides);
  return sampleHash(sampleIdentity(config, resolvePersonas(config), { seed, size }));
}

describe('sampleHash', () => {
  it('is a stable sha256 that ignores key order', () => {
    expect(hashOf()).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf()).toBe(hashOf());
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"e":2,"f":1}]},"b":1}',
    );
  });

  it('does not change when a variant changes, and changes when the sample does', () => {
    const base = hashOf();
    const config = testConfig();
    const otherVariant = AgonConfigSchema.parse({
      ...config,
      target: {
        ...config.target,
        variants: {
          control: { url: 'http://control.test' },
          treatment: { url: 'http://pr-999.test', gitRef: 'abc123', squad: 'blue' },
          extra: { url: 'http://extra.test' },
        },
      },
    });
    expect(
      sampleHash(
        sampleIdentity(otherVariant, resolvePersonas(otherVariant), { seed: 42, size: 4 }),
      ),
    ).toBe(base);

    expect(
      hashOf({
        scenarios: [
          {
            id: 'first-project',
            goal: 'Sign up and create a first project, then invite a colleague.',
            success: 'event:project_created',
          },
        ],
      }),
    ).not.toBe(base);
    expect(hashOf({}, 43, 4)).not.toBe(base);
    expect(hashOf({}, 42, 5)).not.toBe(base);
    expect(hashOf({ analysis: { calibrationProfile: 'onboarding-v1' } })).not.toBe(base);
    expect(hashOf({ defaults: { model: 'fake/model-2', temperature: 0 } })).not.toBe(base);
    expect(
      hashOf({
        population: { seed: 42, size: 4, personas: [{ use: 'impatient' }], traitJitter: 0 },
      }),
    ).not.toBe(base);
  });

  it('keys variants by name and spec so a redeploy under the same name is a new trial', () => {
    const a = variantKey('treatment', { url: 'http://a.test', env: {}, headers: {} });
    expect(a).toMatch(/^treatment@[0-9a-f]{12}$/);
    expect(variantKey('treatment', { url: 'http://a.test', env: {}, headers: {} })).toBe(a);
    expect(variantKey('treatment', { url: 'http://b.test', env: {}, headers: {} })).not.toBe(a);
    expect(
      variantKey('treatment', { url: 'http://a.test', env: {}, headers: {}, gitRef: 'v2' }),
    ).not.toBe(a);
    // Description and squad are metadata, not identity.
    expect(
      variantKey('treatment', {
        url: 'http://a.test',
        env: {},
        headers: {},
        description: 'x',
        squad: 'blue',
      }),
    ).toBe(a);
  });
});
