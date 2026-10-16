/**
 * Redirect-target validation.
 *
 * Kept in its own module with no Workers-only imports so it can be unit tested
 * directly, and so the rule lives in exactly one place.
 */

/**
 * Only same-origin, absolute-path redirects are honoured.
 *
 * Rejects protocol-relative (`//evil.example`), absolute (`https://evil.example`)
 * and backslash-smuggled paths. Returns null when the value is not safe, and the
 * caller falls back to a known-good default.
 */
export function safeNext(value: string | undefined | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || value.includes('://')) return null;
  return value;
}
