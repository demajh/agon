import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@agon/adapters', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agon/adapters');
  });
});
