import { defineConfig } from 'vitest/config';

// Every file launches real Chromium against in-process demo apps. Files run one at a time so a
// machine never runs two browsers and four servers at once, and tests get generous time: a
// control-variant signup walks five onboarding steps through a live browser.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
