/**
 * Rate limiting: the pure parts.
 *
 * The counter itself needs a database and is covered by
 * `test/integration/rate-limit.test.ts`. Everything here is the logic that
 * decides *what* the limit is and *how* it is keyed, which is where a mistake
 * would be silent and dangerous — a spec parsed as zero denies everybody, and a
 * bucket that leaks an IP is a privacy bug.
 */

import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_DEFAULTS,
  RATE_LIMIT_NAMES,
  bucketKey,
  bucketKeyFromIds,
  clientIp,
  parseRateLimitSpec,
  purgeExpiredRateLimits,
  rateLimitEnabled,
  rateLimitSpecFor,
  rateLimitVarName,
  tooManyRequests,
  windowBounds,
  type RateLimitOutcome
} from '../../src/shared/rate-limit.js';

describe('spec parsing', () => {
  const fallback = { limit: 10, windowSeconds: 60 };

  it('parses "limit/window"', () => {
    expect(parseRateLimitSpec('5/900', fallback)).toEqual({ limit: 5, windowSeconds: 900 });
    expect(parseRateLimitSpec(' 120 / 3600 ', fallback)).toEqual({ limit: 120, windowSeconds: 3600 });
  });

  it('falls back rather than throwing on anything malformed', () => {
    for (const raw of ['', '   ', '10', '10/', '/60', 'ten/60', '10/sixty', '0/60', '-5/60', '10/0', '10/-1']) {
      expect(parseRateLimitSpec(raw, fallback), `raw=${JSON.stringify(raw)}`).toEqual(fallback);
    }
  });

  it('never yields a zero limit, which would deny every request', () => {
    // A mis-typed variable must not take the service down.
    expect(parseRateLimitSpec('0/0', fallback).limit).toBe(fallback.limit);
    expect(parseRateLimitSpec('abc/def', fallback).limit).toBe(fallback.limit);
  });

  it('maps every bucket to a distinct variable name', () => {
    const names = RATE_LIMIT_NAMES.map(rateLimitVarName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('RL_MCP');
    expect(names).toContain('RL_SIGNIN');
  });

  it('reads an override from the environment and otherwise uses the default', () => {
    expect(rateLimitSpecFor({ RL_MCP: '7/30' }, 'mcp')).toEqual({ limit: 7, windowSeconds: 30 });
    expect(rateLimitSpecFor({}, 'mcp')).toEqual(RATE_LIMIT_DEFAULTS.mcp);
    expect(rateLimitSpecFor({ RL_MCP: 'nonsense' }, 'mcp')).toEqual(RATE_LIMIT_DEFAULTS.mcp);
  });

  it('is enabled unless explicitly disabled', () => {
    expect(rateLimitEnabled({})).toBe(true);
    expect(rateLimitEnabled({ RATE_LIMIT_ENABLED: 'true' })).toBe(true);
    expect(rateLimitEnabled({ RATE_LIMIT_ENABLED: 'false' })).toBe(false);
  });

  it('configures every bucket with a positive limit and window', () => {
    for (const name of RATE_LIMIT_NAMES) {
      const spec = RATE_LIMIT_DEFAULTS[name];
      expect(spec.limit, name).toBeGreaterThan(0);
      expect(spec.windowSeconds, name).toBeGreaterThan(0);
    }
  });

  it('keeps the sign-in window tight and the MCP window short', () => {
    // These two are the ones a reviewer will look at first.
    expect(RATE_LIMIT_DEFAULTS.signin.limit).toBeLessThanOrEqual(20);
    expect(RATE_LIMIT_DEFAULTS.signin.windowSeconds).toBeGreaterThanOrEqual(300);
    expect(RATE_LIMIT_DEFAULTS.register.limit).toBeLessThanOrEqual(20);
    expect(RATE_LIMIT_DEFAULTS.mcp.windowSeconds).toBeLessThanOrEqual(120);
  });
});

describe('window arithmetic', () => {
  it('aligns windows to a fixed grid', () => {
    expect(windowBounds(1_000, 60)).toEqual({ start: 0, end: 60_000 });
    expect(windowBounds(1_000_000, 60)).toEqual({ start: 960_000, end: 1_020_000 });
  });

  it('is stable inside a window', () => {
    const a = windowBounds(1_000, 60);
    const b = windowBounds(1_059, 60);
    expect(a).toEqual(b);
  });

  it('rolls over exactly at the boundary', () => {
    expect(windowBounds(1_019_999, 60).start).toBe(960_000);
    expect(windowBounds(1_020_000, 60).start).toBe(1_020_000);
  });

  it('handles a one-second window', () => {
    expect(windowBounds(1_500, 1)).toEqual({ start: 1_000, end: 2_000 });
  });
});

describe('bucket keys', () => {
  const secret = 'a-secret-at-least-32-characters-long';

  it('is deterministic for the same inputs', async () => {
    expect(await bucketKey(secret, 'signin', '203.0.113.9', 'a@b.test')).toBe(
      await bucketKey(secret, 'signin', '203.0.113.9', 'a@b.test')
    );
  });

  it('separates buckets by category and by each identifier', async () => {
    const base = await bucketKey(secret, 'signin', 'ip', 'email');
    expect(await bucketKey(secret, 'authorize', 'ip', 'email')).not.toBe(base);
    expect(await bucketKey(secret, 'signin', 'other-ip', 'email')).not.toBe(base);
    expect(await bucketKey(secret, 'signin', 'ip', 'other-email')).not.toBe(base);
  });

  it('does not let two identifiers be confused by concatenation', async () => {
    // Without a separator, ('ab','c') and ('a','bc') would collide.
    expect(await bucketKey(secret, 'signin', 'ab', 'c')).not.toBe(await bucketKey(secret, 'signin', 'a', 'bc'));
  });

  it('never contains the identifiers it was derived from', async () => {
    const key = await bucketKey(secret, 'signin', '203.0.113.9', 'someone@example.test');
    expect(key).not.toContain('203.0.113.9');
    expect(key).not.toContain('someone');
    expect(key).not.toContain('example');
  });

  it('changes when the secret changes, so a rotated secret resets counters', async () => {
    expect(await bucketKey(secret, 'signin', 'ip')).not.toBe(await bucketKey(`${secret}x`, 'signin', 'ip'));
  });

  it('produces a fixed-length key whatever the input length', async () => {
    const short = await bucketKey(secret, 'signin', 'a');
    const long = await bucketKey(secret, 'signin', 'x'.repeat(5000));
    expect(short.length).toBe(long.length);
    expect(short).toMatch(/^signin:[0-9a-f]{32}$/);
  });

  it('omits absent identifiers deterministically', async () => {
    expect(await bucketKey(secret, 'token', 'ip', undefined)).toBe(await bucketKey(secret, 'token', 'ip', null));
  });

  it('keys non-PII identifiers without a secret', async () => {
    const key = await bucketKeyFromIds('mcp', 'user_abc', 'client_xyz');
    expect(key).toMatch(/^mcp:[0-9a-f]{32}$/);
    expect(key).not.toContain('user_abc');
    expect(await bucketKeyFromIds('mcp', 'user_abc', 'client_xyz')).toBe(key);
    expect(await bucketKeyFromIds('mcp', 'user_abc', 'other')).not.toBe(key);
  });
});

describe('client address', () => {
  it('prefers the Cloudflare header, which a client cannot set through the proxy', () => {
    const request = new Request('https://example.com/', {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' }
    });
    expect(clientIp(request)).toBe('203.0.113.7');
  });

  it('falls back to the first X-Forwarded-For entry', () => {
    const request = new Request('https://example.com/', { headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } });
    expect(clientIp(request)).toBe('198.51.100.4');
  });

  it('reports unknown rather than an empty string', () => {
    expect(clientIp(new Request('https://example.com/'))).toBe('unknown');
    expect(clientIp(new Request('https://example.com/', { headers: { 'cf-connecting-ip': '  ' } }))).toBe('unknown');
  });
});

describe('the 429 response', () => {
  const outcome: RateLimitOutcome = {
    allowed: false,
    limit: 10,
    remaining: 0,
    resetAt: 1_700_000_060_000,
    retryAfterSeconds: 42
  };

  it('is a 429 with Retry-After and rate-limit headers', async () => {
    const response = tooManyRequests(outcome, { format: 'json' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(response.headers.get('x-ratelimit-limit')).toBe('10');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('speaks OAuth when the caller is an OAuth endpoint', async () => {
    const body = (await tooManyRequests(outcome, { format: 'oauth' }).json()) as Record<string, string>;
    expect(body.error).toBe('temporarily_unavailable');
    expect(body.error_description).toBeTruthy();
  });

  it('speaks plain JSON elsewhere', async () => {
    const body = (await tooManyRequests(outcome, { format: 'json' }).json()) as Record<string, string>;
    expect(body.error).toBe('rate_limited');
    expect(body.message).toBeTruthy();
  });

  it('leaks nothing about the bucket it was built from', async () => {
    const text = await tooManyRequests(outcome, { format: 'json' }).text();
    expect(text).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('counter pruning', () => {
  it('deletes only windows older than the retention period', async () => {
    const seen: unknown[][] = [];
    const fakeDb = {
      prepare(sql: string) {
        expect(sql).toContain('DELETE FROM rate_limits WHERE window_start < ?');
        return {
          bind(...args: unknown[]) {
            seen.push(args);
            return { run: async () => ({ meta: { changes: 3 } }) };
          }
        };
      }
    } as unknown as D1Database;

    const now = 1_800_000_000_000;
    const deleted = await purgeExpiredRateLimits(fakeDb, now, 60_000);
    expect(deleted).toBe(3);
    expect(seen[0]?.[0]).toBe(now - 60_000);
  });
});
