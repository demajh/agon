import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@agon/db', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@agon/db');
  });
});
