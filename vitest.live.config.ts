import { defineConfig } from 'vitest/config';

/**
 * Live tests: the ones that talk to a real Bludit installation.
 *
 * Kept in a separate config on purpose. The default suite (`vitest.config.ts`)
 * must stay hermetic — no network, no Docker, no credentials — so that it is
 * always runnable. These tests require `scripts/live-bludit-up.sh` to have been
 * run first, and they skip themselves when no credentials are present.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // A live site is a shared, stateful resource; one file at a time.
    fileParallelism: false,
    reporters: ['default', ['junit', { outputFile: 'reports/live-junit.xml' }]]
  }
});
