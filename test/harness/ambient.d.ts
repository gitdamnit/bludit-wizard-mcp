/**
 * Ambient declarations for the test harness.
 *
 * `migrations/*.sql` is imported as text so the test-only schema Worker can
 * apply it. Wrangler's `Text` rule does the bundling; this only satisfies the
 * type checker.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
