import { defineConfig } from '@playwright/test';

/**
 * Browser tests.
 *
 * These cover the one layer the HTTP-level integration tests cannot: real
 * rendering, real cookie handling, and real form submission in a browser.
 *
 * There is no `webServer` block. The harness starts a real local HTTP server
 * inside the test file (`createTestHarness(...).listen()`), so each run owns its
 * Workers, its D1 database and its port.
 */
export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['junit', { outputFile: 'reports/playwright-junit.xml' }]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure'
  }
});
