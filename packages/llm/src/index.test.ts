import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@agon/llm', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agon/llm');
  });
});
