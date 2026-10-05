import { describe, expect, it } from 'vitest';
import { clamp01, createRng, hashSeed } from './rng.js';

describe('rng', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = Array.from({ length: 5 }, () => createRng(7).next());
    const b = Array.from({ length: 5 }, () => createRng(7).next());
    expect(a).toEqual(b);
    const seq1 = createRng(7);
    const seq2 = createRng(8);
    expect(Array.from({ length: 5 }, () => seq1.next())).not.toEqual(
      Array.from({ length: 5 }, () => seq2.next()),
    );
  });

  it('produces floats in [0,1) and ints in range', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('weighted pick follows the weights', () => {
    const rng = createRng(3);
    const counts = [0, 0, 0];
    for (let i = 0; i < 6000; i++) counts[rng.pick([1, 2, 3])]!++;
    expect(counts[0]! / 6000).toBeCloseTo(1 / 6, 1);
    expect(counts[2]! / 6000).toBeCloseTo(3 / 6, 1);
    expect(() => rng.pick([0, 0])).toThrow(RangeError);
  });

  it('gaussian has roughly zero mean and unit variance', () => {
    const rng = createRng(11);
    const xs = Array.from({ length: 20000 }, () => rng.gaussian());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });

  it('forks are independent and reproducible; hashSeed is stable', () => {
    expect(hashSeed(1, 'a')).toBe(hashSeed(1, 'a'));
    expect(hashSeed(1, 'a')).not.toBe(hashSeed(1, 'b'));
    expect(createRng(5).fork('x').next()).toBe(createRng(5).fork('x').next());
    expect(createRng(5).fork('x').next()).not.toBe(createRng(5).fork('y').next());
    expect(createRng(2).shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});
