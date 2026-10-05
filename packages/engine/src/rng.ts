import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { RandomGenerator } from 'pure-rand/types/RandomGenerator';

/** Seeded random source. Every random choice in the engine flows through one of these. */
export interface Rng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Index drawn with probability proportional to its weight. */
  pick(weights: readonly number[]): number;
  /** Standard normal deviate (Box-Muller). */
  gaussian(): number;
  /** Fisher-Yates shuffle of a copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** Independent generator derived deterministically from this seed and a label. */
  fork(label: string | number): Rng;
}

/** FNV-1a 32-bit hash of the joined parts; used to derive child seeds. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join(':');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  const gen: RandomGenerator = xoroshiro128plus(seed >>> 0);
  const next = (): number => uniformInt(gen, 0, 0x7fffffff) / 0x80000000;
  // Burn-in: the first outputs of xoroshiro seeded from a small integer are correlated with the
  // seed, which biases the very first draw of every per-session generator. Discard them.
  for (let i = 0; i < 16; i++) next();
  const rng: Rng = {
    seed,
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`int(${min}, ${max}): max < min`);
      return uniformInt(gen, min, max);
    },
    pick(weights) {
      const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
      if (!(total > 0)) throw new RangeError('pick(): weights must sum to a positive number');
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i] as number);
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
    gaussian() {
      const u1 = 1 - next();
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const tmp = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = tmp;
      }
      return out;
    },
    fork(label) {
      return createRng(hashSeed(seed, label));
    },
  };
  return rng;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
