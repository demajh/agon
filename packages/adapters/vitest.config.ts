import { defineConfig } from 'vitest/config';

// The web adapter tests drive a real headless Chromium against a local fixture server, so they
// need more than vitest's default 5 s per test.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
