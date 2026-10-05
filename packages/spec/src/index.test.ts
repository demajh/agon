import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@agon/spec', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agon/spec');
  });
});
