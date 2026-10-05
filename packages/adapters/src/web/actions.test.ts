import { describe, expect, it } from 'vitest';
import {
  isTargetClosedError,
  normalizeKey,
  parseBooleanText,
  resolveNavigationUrl,
  shortErrorMessage,
} from './actions.js';

describe('normalizeKey', () => {
  it('maps loose key names onto Playwright names', () => {
    expect(normalizeKey('enter')).toBe('Enter');
    expect(normalizeKey('Return')).toBe('Enter');
    expect(normalizeKey('esc')).toBe('Escape');
    expect(normalizeKey('ctrl+a')).toBe('Control+a');
    expect(normalizeKey('cmd + Enter')).toBe('Meta+Enter');
    expect(normalizeKey('Shift+Tab')).toBe('Shift+Tab');
    expect(normalizeKey('down')).toBe('ArrowDown');
    expect(normalizeKey('f5')).toBe('F5');
    expect(normalizeKey('space')).toBe('Space');
  });

  it('passes single characters and unknown names through', () => {
    expect(normalizeKey('a')).toBe('a');
    expect(normalizeKey('A')).toBe('A');
    expect(normalizeKey('ArrowDown')).toBe('ArrowDown');
    expect(normalizeKey('Bogus')).toBe('Bogus');
  });
});

describe('resolveNavigationUrl', () => {
  const current = 'https://app.example.com/account/settings?tab=1';

  it('resolves relative targets against the current page', () => {
    expect(resolveNavigationUrl('/pricing', current).href).toBe('https://app.example.com/pricing');
    expect(resolveNavigationUrl('billing', current).href).toBe(
      'https://app.example.com/account/billing',
    );
    expect(resolveNavigationUrl('index.html', current).href).toBe(
      'https://app.example.com/account/index.html',
    );
    expect(resolveNavigationUrl('?tab=2', current).href).toBe(
      'https://app.example.com/account/settings?tab=2',
    );
  });

  it('keeps absolute URLs and upgrades bare hosts to https', () => {
    expect(resolveNavigationUrl('http://localhost:3000/x', current).href).toBe(
      'http://localhost:3000/x',
    );
    expect(resolveNavigationUrl('example.com/pricing', current).href).toBe(
      'https://example.com/pricing',
    );
    expect(resolveNavigationUrl('www.example.com', current).href).toBe('https://www.example.com/');
    expect(resolveNavigationUrl('//cdn.example.com/a', current).href).toBe(
      'https://cdn.example.com/a',
    );
  });

  it('rejects empty, unparsable and non-http targets', () => {
    expect(() => resolveNavigationUrl('  ', current)).toThrow(/empty/);
    expect(() => resolveNavigationUrl('javascript:alert(1)', current)).toThrow(/only http/);
    expect(() => resolveNavigationUrl('mailto:a@b.c', current)).toThrow(/only http/);
    expect(() => resolveNavigationUrl('/relative', undefined)).toThrow(/cannot resolve/);
  });
});

describe('parseBooleanText', () => {
  it('understands the usual spellings', () => {
    expect(parseBooleanText('true')).toBe(true);
    expect(parseBooleanText(' Yes ')).toBe(true);
    expect(parseBooleanText('checked')).toBe(true);
    expect(parseBooleanText('false')).toBe(false);
    expect(parseBooleanText('off')).toBe(false);
    expect(parseBooleanText('')).toBe(false);
    expect(parseBooleanText('maybe')).toBeUndefined();
  });
});

describe('shortErrorMessage', () => {
  it('keeps the first non-empty line and truncates', () => {
    expect(
      shortErrorMessage(new Error('\nlocator.click: Timeout 2000ms exceeded.\nCall log:\n  - x')),
    ).toBe('locator.click: Timeout 2000ms exceeded.');
    expect(shortErrorMessage('plain string')).toBe('plain string');
    expect(shortErrorMessage(new Error('x'.repeat(300)), 20)).toHaveLength(20);
    expect(shortErrorMessage(new Error(''))).toBe('unknown error');
  });
});

describe('isTargetClosedError', () => {
  it('recognises Playwright closed-target failures only', () => {
    expect(isTargetClosedError(new Error('Target page, context or browser has been closed'))).toBe(
      true,
    );
    expect(
      isTargetClosedError(new Error('Protocol error (Runtime.callFunctionOn): Target closed')),
    ).toBe(true);
    expect(isTargetClosedError(new Error('Timeout 10000ms exceeded.'))).toBe(false);
    expect(
      isTargetClosedError(
        new Error('Execution context was destroyed, most likely because of a navigation'),
      ),
    ).toBe(false);
    expect(isTargetClosedError('not an error')).toBe(false);
  });
});
