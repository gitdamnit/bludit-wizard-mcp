import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test runs in Node. Tests that need real Workers semantics start
    // workerd through wrangler's `createTestHarness`, which is a Miniflare
    // runtime, so there is no need for a separate Workers test environment.
    environment: 'node',
    // Live tests need Docker and real credentials, so they are excluded here and
    // run from `vitest.live.config.ts`. The default suite stays hermetic.
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/compat/**/*.test.ts',
      // The local stdio edition. Hermetic, Node-only, no Miniflare: it drives the
      // real MCP protocol against the real tools and a real HTTP Bludit API.
      'test/local/**/*.test.ts'
    ],
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
