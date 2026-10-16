/**
 * Rate limiting.
 *
 * Counters live in D1 rather than KV or memory:
 *
 *  - **Not KV.** Workers KV allows one write per second to the same key, is
 *    eventually consistent, and its free tier allows 1,000 writes a day. A
 *    limiter built on it would under-count exactly when it matters.
 *  - **Not in-memory.** An isolate-local counter is not a limit; an attacker
 *    gets a fresh budget per isolate and per colo.
 *  - **D1** is a single-writer SQLite database, so a fixed-window UPSERT is
 *    atomic and global, and it is already a dependency of both Workers.
 *
 * The trade-off is honest and documented: one row read and one row write per
 * limited request, which shows up in D1 usage. `ARCHITECTURE.md` quantifies it.
 * Cloudflare's Rate Limiting binding would be cheaper, but it is per-colo and
 * would not be exercisable from the test harness, so it is documented as an
 * optional additional layer rather than the mechanism.
 *
 * Privacy: a bucket is `category:HMAC-SHA256(secret, identifiers)`. Raw IP
 * addresses and email addresses never reach the database, and a leak cannot be
 * turned back into a list of who was using the service.
 */

import { hmacHex, sha256Hex } from './crypto.js';
import { logger } from './log.js';

export interface RateLimitSpec {
  /** Maximum requests allowed inside one window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Defaults. Deliberately generous enough for real use and tight enough to bound
 * abuse; every one is overridable per deployment with `RL_<NAME>`.
 */
export const RATE_LIMIT_DEFAULTS = {
  /** Sign-in attempts, per IP **and** email. Brute-force protection. */
  signin: { limit: 10, windowSeconds: 900 },
  /** Authorization requests, per IP. */
  authorize: { limit: 240, windowSeconds: 3600 },
  /** Token and revocation requests, per IP and client. */
  token: { limit: 240, windowSeconds: 3600 },
  /** Dynamic Client Registration, per IP. Registration spam is the target. */
  register: { limit: 10, windowSeconds: 3600 },
  /** Pairing challenges, per account. */
  pairing: { limit: 20, windowSeconds: 3600 },
  /** Connection attempts, per account, successful or not. */
  connect: { limit: 30, windowSeconds: 3600 },
  /** MCP requests, per account and client. */
  mcp: { limit: 300, windowSeconds: 60 }
} as const satisfies Record<string, RateLimitSpec>;

export type RateLimitName = keyof typeof RATE_LIMIT_DEFAULTS;

export const RATE_LIMIT_NAMES = Object.keys(RATE_LIMIT_DEFAULTS) as RateLimitName[];

/** Anything with the rate-limit variables on it. */
export interface RateLimitEnv {
  RATE_LIMIT_ENABLED?: string;
  RL_SIGNIN?: string;
  RL_AUTHORIZE?: string;
  RL_TOKEN?: string;
  RL_REGISTER?: string;
  RL_PAIRING?: string;
  RL_CONNECT?: string;
  RL_MCP?: string;
}

export function rateLimitEnabled(env: RateLimitEnv): boolean {
  return env.RATE_LIMIT_ENABLED !== 'false';
}

/** The environment variable that overrides a bucket, e.g. `RL_MCP`. */
export function rateLimitVarName(name: RateLimitName): keyof RateLimitEnv {
  return `RL_${name.toUpperCase()}` as keyof RateLimitEnv;
}

/**
 * Parse `"<limit>/<windowSeconds>"`.
 *
 * Returns the fallback for anything malformed rather than throwing: a typo in a
 * deployment variable must not take the service down, and a limit that silently
 * became zero would deny every request.
 */
export function parseRateLimitSpec(raw: string | undefined, fallback: RateLimitSpec): RateLimitSpec {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parts = raw.trim().split('/');
  if (parts.length !== 2) return fallback;
  const limit = Number.parseInt(parts[0] as string, 10);
  const windowSeconds = Number.parseInt(parts[1] as string, 10);
  if (!Number.isFinite(limit) || limit < 1) return fallback;
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) return fallback;
  return { limit, windowSeconds };
}

export function rateLimitSpecFor(env: RateLimitEnv, name: RateLimitName): RateLimitSpec {
  return parseRateLimitSpec(env[rateLimitVarName(name)] as string | undefined, RATE_LIMIT_DEFAULTS[name]);
}

/** Start and end of the fixed window containing `now`. Pure, so it is testable. */
export function windowBounds(now: number, windowSeconds: number): { start: number; end: number } {
  const size = windowSeconds * 1000;
  const start = Math.floor(now / size) * size;
  return { start, end: start + size };
}

export interface RateLimitOutcome {
  allowed: boolean;
  limit: number;
  /** Requests still available in this window; 0 once the limit is reached. */
  remaining: number;
  /** Epoch milliseconds at which the window resets. */
  resetAt: number;
  /** Whole seconds to put in `Retry-After` when not allowed. */
  retryAfterSeconds: number;
}

/**
 * Count one request against a bucket.
 *
 * The counter is incremented even when the request is refused, so a client that
 * keeps going does not get a free pass at the start of the next window.
 *
 * On a storage failure this **fails open** and logs. D1 being unavailable
 * already breaks the service — sessions, sites and proposals all live there — so
 * failing closed would convert a partial outage into a total one without
 * improving security. The decision is recorded in `SECURITY.md`.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  spec: RateLimitSpec,
  now: number = Date.now()
): Promise<RateLimitOutcome> {
  const { start, end } = windowBounds(now, spec.windowSeconds);

  let count: number;
  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
         RETURNING count`
      )
      .bind(bucket, start)
      .first<{ count: number }>();
    count = row?.count ?? 1;
  } catch (error) {
    logger.warn('rate_limit.storage_failed', {
      bucket: bucket.split(':')[0] ?? 'unknown',
      error: error instanceof Error ? error.name : 'unknown'
    });
    return { allowed: true, limit: spec.limit, remaining: spec.limit, resetAt: end, retryAfterSeconds: 0 };
  }

  const allowed = count <= spec.limit;
  return {
    allowed,
    limit: spec.limit,
    remaining: Math.max(0, spec.limit - count),
    resetAt: end,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((end - now) / 1000))
  };
}

/** Delete windows that ended more than `olderThanMs` ago. */
export async function purgeExpiredRateLimits(
  db: D1Database,
  now: number = Date.now(),
  olderThanMs = 24 * 60 * 60 * 1000
): Promise<number> {
  const result = await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - olderThanMs).run();
  return result.meta?.changes ?? 0;
}

/**
 * Build an opaque bucket key from non-PII identifiers.
 *
 * Used where the identifiers are already random opaque ids (an account id, an
 * OAuth client id), so a plain digest is enough and no secret is needed.
 */
export async function bucketKeyFromIds(
  category: RateLimitName,
  ...identifiers: Array<string | undefined | null>
): Promise<string> {
  const material = identifiers.map((value) => value ?? '-').join('\u0000');
  return `${category}:${(await sha256Hex(`${category}\u0000${material}`)).slice(0, 32)}`;
}

/**
 * Build an opaque bucket key from identifiers that may contain PII — an IP
 * address, an email address. Only a keyed digest reaches storage, so a database
 * leak reveals counts without revealing who was counting.
 */
export async function bucketKey(
  secret: string,
  category: RateLimitName,
  ...identifiers: Array<string | undefined | null>
): Promise<string> {
  const material = identifiers.map((value) => value ?? '-').join('\u0000');
  return `${category}:${(await hmacHex(secret, `${category}\u0000${material}`)).slice(0, 32)}`;
}

export type RateLimitBodyFormat = 'oauth' | 'json';

/** A `429` carrying `Retry-After`, in the shape the caller's protocol expects. */
export function tooManyRequests(
  outcome: RateLimitOutcome,
  options: { format: RateLimitBodyFormat; message?: string } = { format: 'json' }
): Response {
  const description = options.message ?? 'Too many requests. Please try again later.';
  const body =
    options.format === 'oauth'
      ? { error: 'temporarily_unavailable', error_description: description }
      : { error: 'rate_limited', message: description };

  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(outcome.retryAfterSeconds),
      'x-ratelimit-limit': String(outcome.limit),
      'x-ratelimit-remaining': String(outcome.remaining),
      'x-ratelimit-reset': String(Math.ceil(outcome.resetAt / 1000))
    }
  });
}

/**
 * The caller's IP, as Cloudflare reports it.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by a client on a
 * proxied request. The `X-Forwarded-For` fallback exists only so the test
 * harness and `wrangler dev` behave sensibly; a deployment that is not behind
 * Cloudflare should not trust it.
 */
export function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf && cf.trim() !== '') return cf.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

/**
 * Count a request against a bucket, returning a `429` when it is over the limit.
 *
 * Pass `secret` when any identifier is personal data; omit it when every
 * identifier is already an opaque random id.
 */
export async function enforceRateLimit(
  db: D1Database,
  env: RateLimitEnv,
  name: RateLimitName,
  identifiers: Array<string | undefined | null>,
  options: { format: RateLimitBodyFormat; message?: string; now?: number; secret?: string }
): Promise<Response | null> {
  if (!rateLimitEnabled(env)) return null;
  const bucket = options.secret
    ? await bucketKey(options.secret, name, ...identifiers)
    : await bucketKeyFromIds(name, ...identifiers);
  const outcome = await consumeRateLimit(db, bucket, rateLimitSpecFor(env, name), options.now ?? Date.now());
  if (outcome.allowed) return null;
  logger.warn('rate_limit.exceeded', { bucket: name, limit: outcome.limit, retryAfter: outcome.retryAfterSeconds });
  return tooManyRequests(outcome, { format: options.format, ...(options.message ? { message: options.message } : {}) });
}
