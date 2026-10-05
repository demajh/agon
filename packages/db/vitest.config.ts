import { defineConfig } from 'vitest/config';

// Every test file shares the agon_test database and truncates it between tests, so files must not
// run concurrently.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
