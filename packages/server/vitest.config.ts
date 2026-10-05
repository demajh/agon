import { defineConfig } from 'vitest/config';

// Every test file shares the agon_server_test database and truncates it between tests, so files
// must not run concurrently.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
