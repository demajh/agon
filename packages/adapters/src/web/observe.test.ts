import { ObservationSchema } from '@agon/spec';
import { describe, expect, it } from 'vitest';
import { buildObservation, cutText, normalizeText, observationHash } from './observe.js';

describe('normalizeText', () => {
  it('collapses inline whitespace, keeps line breaks and squeezes blank runs', () => {
    expect(normalizeText('  Title \t here \r\n\n\n\nBody text  \n  \n')).toBe(
      'Title here\n\nBody text',
    );
    expect(normalizeText('\n\n\nlead')).toBe('lead');
    expect(normalizeText('zero​width')).toBe('zerowidth');
  });
});

describe('cutText', () => {
  it('cuts at a whitespace boundary when one lies within the keep window', () => {
    expect(cutText('alpha beta gamma delta', 16)).toBe('alpha beta gamma');
    // The default window is 80% of the limit: 11 of 14, and the last space sits at 10.
    expect(cutText('alpha beta gamma delta', 14)).toBe('alpha beta gam');
    expect(cutText('alpha beta gamma delta', 14, 8)).toBe('alpha beta');
  });

  it('cuts hard when no boundary lies within the keep window', () => {
    expect(cutText('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
    expect(cutText('a bcdefghijklmnopqrstuvwxyz', 10, 9)).toBe('a bcdefghi');
  });

  it('returns short text untouched', () => {
    expect(cutText('short', 10)).toBe('short');
  });
});

describe('buildObservation', () => {
  const raw = {
    url: 'https://app.example.com/',
    title: 'Home',
    text: 'Heading\n\n\n  Some   body text  \n',
    interactive: [
      {
        ref: 'e1',
        role: 'link',
        name: 'Pricing',
        href: 'https://app.example.com/pricing',
        disabled: false,
      },
      { ref: 'e2', role: 'textbox', name: 'Email', value: '', disabled: false },
      { ref: 'e3', role: 'button', name: 'Go', disabled: true },
    ],
  };

  it('normalises text, keeps every element under the caps and validates against the schema', () => {
    const obs = buildObservation(raw, {
      errors: ['console.error: x'],
      capturedAt: '2026-10-04T17:00:00.000Z',
    });
    expect(obs.text).toBe('Heading\n\nSome body text');
    expect(obs.interactive).toHaveLength(3);
    expect(obs.truncated).toBe(false);
    expect(obs.errors).toEqual(['console.error: x']);
    expect(obs.title).toBe('Home');
    expect(obs.capturedAt).toBe('2026-10-04T17:00:00.000Z');
    expect(obs.screenshotRef).toBeUndefined();
    expect(obs.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(ObservationSchema.safeParse(obs).success).toBe(true);
  });

  it('truncates interactive elements and text in document order and says so', () => {
    const obs = buildObservation(raw, { maxInteractive: 2, maxTextChars: 7 });
    expect(obs.interactive.map((e) => e.ref)).toEqual(['e1', 'e2']);
    expect(obs.text).toBe('Heading');
    expect(obs.truncated).toBe(true);
  });

  it('hashes what is returned: stable for equal views, different when content differs', () => {
    const a = buildObservation(raw, { capturedAt: '2026-10-04T17:00:00.000Z' });
    const b = buildObservation(raw, {
      capturedAt: '2026-10-04T18:00:00.000Z',
      errors: ['ignored by hash'],
    });
    expect(a.hash).toBe(b.hash);
    const changedText = buildObservation({ ...raw, text: 'Different' });
    expect(changedText.hash).not.toBe(a.hash);
    const changedValue = buildObservation({
      ...raw,
      interactive: raw.interactive.map((e) =>
        e.ref === 'e2' ? { ...e, value: 'ada@example.com' } : e,
      ),
    });
    expect(changedValue.hash).not.toBe(a.hash);
    expect(observationHash(raw.url, 'Heading\n\nSome body text', raw.interactive)).toBe(a.hash);
  });

  it('ignores invalid caps and falls back to the defaults', () => {
    const many = {
      ...raw,
      interactive: Array.from({ length: 50 }, (_, i) => ({
        ref: `e${i}`,
        role: 'button',
        name: `${i}`,
        disabled: false,
      })),
    };
    expect(buildObservation(many, { maxInteractive: 0 }).interactive).toHaveLength(40);
    expect(buildObservation(many, { maxInteractive: Number.NaN }).interactive).toHaveLength(40);
  });
});
