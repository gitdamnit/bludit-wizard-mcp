/**
 * Personal access tokens.
 *
 * A compatibility credential, not a second authentication system. Three of the
 * twelve target clients cannot do OAuth at all — GitHub Copilot's cloud agent
 * and code review, Mistral's Vibe Code CLI, and Empryo all document static
 * headers as their only remote option — so without this they cannot connect.
 *
 * Design constraints, deliberate:
 *
 *  - **Same authorization code path.** A token carries a scope set, and the
 *    resource server runs exactly the same per-tool scope and tenancy checks on
 *    it as on an OAuth token. Nothing is bypassed.
 *  - **Owned by one account.** Lookup yields a `user_id`, so every site and
 *    proposal lookup stays scoped.
 *  - **Shown once.** Only a digest is stored, so a database leak yields no usable
 *    credential. The digest is unkeyed SHA-256 rather than an HMAC: the token is
 *    192 bits of randomness, so unlike a password it cannot be guessed offline.
 *  - **Scoped and expiring.** The user chooses the scopes and a lifetime, with a
 *    90-day default. Expiry is enforced on every request, not just in the UI.
 *  - **Revocable, immediately.** Revocation is a row update the very next request
 *    observes, with no propagation delay — better than the OAuth KV path.
 *  - **Auditable.** The audit log records `clientId` as `pat:<id>`, so the trail
 *    shows which token acted.
 *  - **No new secret.** Verification needs no shared key, which keeps the secret
 *    inventory unchanged.
 */

import { randomToken, sha256Hex } from './crypto.js';
import { filterGrantableScopes, hasScopes, REQUIRED_SCOPES, type Scope } from './scopes.js';
import { ToolError } from './errors.js';

/** Recognisable prefix, so a leaked token is greppable and identifiable. */
export const PAT_PREFIX = 'bwpat_';

/** Default lifetime: long enough to be usable, short enough to expire. */
export const DEFAULT_PAT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Shorter ceiling for tokens that a user asks to be short-lived. */
export const MAX_PAT_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface PatRow {
  id: string;
  user_id: string;
  label: string;
  token_hash: string;
  scopes_json: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  revoked_at: number | null;
}

/** Public view of a token. Never contains the token or its digest. */
export interface PatSummary {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revoked: boolean;
  expired: boolean;
}

export function toPatSummary(row: PatRow, now = Date.now()): PatSummary {
  return {
    id: row.id,
    label: row.label,
    scopes: parsePatScopes(row.scopes_json),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at > 0 ? new Date(row.last_used_at).toISOString() : '',
    revoked: row.revoked_at !== null,
    expired: row.expires_at <= now
  };
}

export function parsePatScopes(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** Digest of a presented token. Deterministic, so lookup is a single index hit. */
export async function hashPatToken(token: string): Promise<string> {
  return sha256Hex(`${PAT_PREFIX}${token.replace(PAT_PREFIX, '')}`);
}

export function looksLikePat(token: string): boolean {
  return token.startsWith(PAT_PREFIX);
}

export interface MintedPat {
  id: string;
  /** The only time the token is ever available. */
  token: string;
  expiresAt: number;
  scopes: Scope[];
}

export interface MintPatInput {
  userId: string;
  label: string;
  scopes: string[];
  ttlSeconds?: number;
  now?: number;
}

/**
 * Create a token.
 *
 * Scopes are filtered to the catalogue, and the baseline read scopes are always
 * added: a token that could not even list its owner's sites would be useless, and
 * requiring the caller to ask for them invites a confusing first failure.
 */
export async function mintPat(db: D1Database, input: MintPatInput): Promise<MintedPat> {
  const now = input.now ?? Date.now();
  const label = input.label.trim();
  if (label === '') throw new ToolError('invalid_input', 'A label is required so the token can be recognised later.');

  const requested = filterGrantableScopes([...input.scopes, ...REQUIRED_SCOPES]);
  const scopes = [...new Set(requested)];
  if (!hasScopes(scopes, REQUIRED_SCOPES)) {
    throw new ToolError('invalid_input', 'A token must include the baseline read scopes.');
  }

  const ttl = Math.min(input.ttlSeconds ?? DEFAULT_PAT_TTL_SECONDS, MAX_PAT_TTL_SECONDS);
  const token = `${PAT_PREFIX}${randomToken(24)}`;
  const id = `pat_${randomToken(9)}`;

  await db
    .prepare(
      `INSERT INTO personal_access_tokens
         (id, user_id, label, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,0,NULL)`
    )
    .bind(id, input.userId, label.slice(0, 120), await hashPatToken(token), JSON.stringify(scopes), now, now + ttl * 1000)
    .run();

  return { id, token, expiresAt: now + ttl * 1000, scopes };
}

export async function listPats(db: D1Database, userId: string): Promise<PatRow[]> {
  const result = await db
    .prepare('SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<PatRow>();
  return result.results ?? [];
}

export async function revokePat(db: D1Database, userId: string, id: string, now = Date.now()): Promise<boolean> {
  const result = await db
    .prepare('UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(now, id, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface ResolvedPat {
  id: string;
  userId: string;
  scopes: string[];
  audience: string;
  expiresAt: number;
}

/**
 * Verify a presented token for one resource.
 *
 * Resolves `null` for anything that is not a usable token — unknown, revoked or
 * expired — so the caller can fall through to the OAuth validator without
 * distinguishing the cases to the client.
 */
export async function verifyPat(
  db: D1Database,
  audience: string,
  token: string,
  now: number = Date.now()
): Promise<ResolvedPat | null> {
  if (!looksLikePat(token) || token.length < 20) return null;

  const row = await db
    .prepare('SELECT * FROM personal_access_tokens WHERE token_hash = ?')
    .bind(await hashPatToken(token))
    .first<PatRow>();

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= now) return null;

  const scopes = parsePatScopes(row.scopes_json);
  if (!hasScopes(scopes, REQUIRED_SCOPES)) return null;

  // Best effort: a failed bookkeeping write must not fail an authorized request.
  db.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run().catch(() => undefined);

  return { id: row.id, userId: row.user_id, scopes, audience, expiresAt: row.expires_at };
}

/** The audit-log client id for a token, so the trail shows which one acted. */
export function patClientId(id: string): string {
  return `pat:${id}`;
}
