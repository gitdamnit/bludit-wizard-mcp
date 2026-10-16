import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test runs in Node. Tests that need real Workers semantics start
    // workerd through wrangler's `createTestHarness`, which is a Miniflare
    // runtime, so there is no need for a separate Workers test environment.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'reports/junit.xml'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'reports/coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts']
    },
    pool: 'forks',
    // Each test file starts its own workerd instance; run them one at a time so
    // the suite stays within a modest memory budget.
    fileParallelism: false
  }
});
