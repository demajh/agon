import type { Observation } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { pruneObservation } from './prune.js';

function observation(interactiveCount: number, words: number): Observation {
  return {
    url: 'https://app.example.com/',
    title: 'Example',
    text: Array.from({ length: words }, (_, i) => `word${i}`).join(' '),
    interactive: Array.from({ length: interactiveCount }, (_, i) => ({
      ref: `e${i + 1}`,
      role: 'button',
      name: `Button ${i + 1}`,
      disabled: false,
    })),
    errors: ['console.error: boom'],
    truncated: false,
    hash: 'abc123',
    capturedAt: '2026-10-04T17:00:00.000Z',
  };
}

describe('pruneObservation', () => {
  it('returns an equal copy at full attention and never mutates its input', () => {
    const input = observation(20, 400);
    const snapshot = structuredClone(input);
    const out = pruneObservation(input, { attention: 1 });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out.interactive).not.toBe(input.interactive);
    expect(input).toEqual(snapshot);
  });

  it('keeps a proportional prefix of text and interactive elements', () => {
    const input = observation(20, 400);
    const out = pruneObservation(input, { attention: 0.5 });
    expect(out.interactive).toHaveLength(10);
    expect(out.interactive[0]?.ref).toBe('e1');
    expect(out.interactive[9]?.ref).toBe('e10');
    const budget = Math.ceil(input.text.length * 0.5);
    expect(out.text.length).toBeLessThanOrEqual(budget);
    expect(out.text.length).toBeGreaterThanOrEqual(Math.floor(budget * 0.8));
    expect(input.text.startsWith(out.text)).toBe(true);
    expect(out.text.endsWith(' ')).toBe(false);
    expect(out.truncated).toBe(true);
  });

  it('never drops below 5 interactive elements or 400 characters', () => {
    const input = observation(20, 400);
    const out = pruneObservation(input, { attention: 0 });
    expect(out.interactive).toHaveLength(5);
    expect(out.text.length).toBeGreaterThanOrEqual(400);
    expect(out.text.length).toBeLessThanOrEqual(400);
    expect(out.truncated).toBe(true);
  });

  it('leaves small observations alone', () => {
    const input = observation(3, 20);
    const out = pruneObservation(input, { attention: 0 });
    expect(out.interactive).toHaveLength(3);
    expect(out.text).toBe(input.text);
    expect(out.truncated).toBe(false);
  });

  it('keeps the hash and errors, and preserves an existing truncated flag', () => {
    const input = { ...observation(20, 400), truncated: true };
    const out = pruneObservation(input, { attention: 1 });
    expect(out.hash).toBe('abc123');
    expect(out.errors).toEqual(['console.error: boom']);
    expect(out.truncated).toBe(true);
  });

  it('clamps attention and treats non-finite values as full attention', () => {
    const input = observation(20, 400);
    expect(pruneObservation(input, { attention: 7 })).toEqual(input);
    expect(pruneObservation(input, { attention: Number.NaN })).toEqual(input);
    expect(pruneObservation(input, { attention: -3 }).interactive).toHaveLength(5);
  });

  it('honours custom floors', () => {
    const input = observation(20, 400);
    const out = pruneObservation(input, { attention: 0, minInteractive: 8, minTextChars: 100 });
    expect(out.interactive).toHaveLength(8);
    expect(out.text.length).toBeGreaterThanOrEqual(100);
    expect(out.text.length).toBeLessThanOrEqual(100);
  });
});
