/**
 * Personal access tokens: the pure parts.
 *
 * The verification path needs a database and is covered by
 * `test/integration/pats.test.ts`. Everything here decides whether a token is
 * even recognisable as one, and what a user is shown about it.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAT_TTL_SECONDS,
  MAX_PAT_TTL_SECONDS,
  PAT_PREFIX,
  hashPatToken,
  looksLikePat,
  parsePatScopes,
  toPatSummary,
  type PatRow
} from '../../src/shared/pats.js';

describe('token shape', () => {
  it('uses a recognisable prefix so a leaked token is identifiable', () => {
    expect(PAT_PREFIX).toBe('bwpat_');
  });

  it('recognises its own tokens and nothing else', () => {
    expect(looksLikePat(`${PAT_PREFIX}abcdefghijklmnopqrstuvwx`)).toBe(true);
    expect(looksLikePat('ya29.some-oauth-token')).toBe(false);
    expect(looksLikePat('')).toBe(false);
  });

  it('expires by default, and never beyond a year', () => {
    expect(DEFAULT_PAT_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
    expect(MAX_PAT_TTL_SECONDS).toBeLessThanOrEqual(366 * 24 * 60 * 60);
    expect(DEFAULT_PAT_TTL_SECONDS).toBeLessThan(MAX_PAT_TTL_SECONDS);
  });
});

describe('digest', () => {
  it('is deterministic, so lookup is a single index hit', async () => {
    const token = `${PAT_PREFIX}abcdefghijklmnopqrstuvwx`;
    expect(await hashPatToken(token)).toBe(await hashPatToken(token));
    expect(await hashPatToken(token)).toHaveLength(64);
  });

  it('differs for different tokens', async () => {
    expect(await hashPatToken(`${PAT_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaa`)).not.toBe(
      await hashPatToken(`${PAT_PREFIX}bbbbbbbbbbbbbbbbbbbbbbbb`)
    );
  });

  it('is unaffected by whether the prefix was included', async () => {
    // Tolerance here means a manually copied token without the prefix still works.
    const body = 'abcdefghijklmnopqrstuvwx';
    expect(await hashPatToken(`${PAT_PREFIX}${body}`)).toBe(await hashPatToken(body));
  });
});

describe('scope parsing', () => {
  it('reads a JSON array', () => {
    expect(parsePatScopes('["sites:read","pages:read"]')).toEqual(['sites:read', 'pages:read']);
  });

  it('returns an empty list rather than throwing on anything malformed', () => {
    for (const raw of ['', 'not json', '{}', 'null', '["a", 1, null]']) {
      expect(() => parsePatScopes(raw)).not.toThrow();
      expect(Array.isArray(parsePatScopes(raw))).toBe(true);
    }
  });
});

describe('the summary a user is shown', () => {
  function row(overrides: Partial<PatRow> = {}): PatRow {
    const now = 1_800_000_000_000;
    return {
      id: 'pat_abc',
      user_id: 'user_1',
      label: 'GitHub Copilot',
      token_hash: 'a'.repeat(64),
      scopes_json: '["sites:read","pages:read"]',
      created_at: now,
      expires_at: now + 86_400_000,
      last_used_at: 0,
      revoked_at: null,
      ...overrides
    };
  }

  it('never contains the token or its digest', () => {
    const summary = toPatSummary(row());
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('a'.repeat(64));
    expect(summary).not.toHaveProperty('token');
  });

  it('reports expiry and revocation', () => {
    const now = 1_800_000_000_000;
    expect(toPatSummary(row({ expires_at: now - 1 }), now).expired).toBe(true);
    expect(toPatSummary(row({ expires_at: now + 1000 }), now).expired).toBe(false);
    expect(toPatSummary(row({ revoked_at: now }), now).revoked).toBe(true);
    expect(toPatSummary(row(), now).revoked).toBe(false);
  });

  it('shows a blank last-used value rather than a 1970 date', () => {
    expect(toPatSummary(row()).lastUsedAt).toBe('');
    expect(toPatSummary(row({ last_used_at: 1_800_000_000_000 })).lastUsedAt).toBe('2027-01-15T08:00:00.000Z');
  });

  it('exposes the scopes as an array', () => {
    expect(toPatSummary(row()).scopes).toEqual(['sites:read', 'pages:read']);
  });
});
