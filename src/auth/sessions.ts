/**
 * Browser sessions for the authorization server UI.
 *
 * The session token is a 256-bit random value held only in a `__Host-` cookie.
 * D1 stores its keyed hash, so a database leak does not yield a usable session.
 * The CSRF token is derived from the session token, so it is unguessable
 * without reading the victim's cookie and does not need a second cookie.
 */

import { hmacHex, randomToken } from '../shared/crypto.js';
import { sessionCookieName } from '../shared/cookies.js';
import { constantTimeEqual } from '../shared/crypto.js';
import type { AuthEnv } from '../shared/env.js';
import { findUserById, toPublicUser, type PublicUser, type UserRow } from './accounts.js';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionContext {
  sessionToken: string;
  sessionId: string;
  user: PublicUser;
  userRow: UserRow;
  csrfToken: string;
}

async function sessionIdFor(env: AuthEnv, token: string): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `session:${token}`);
}

export async function createSession(
  env: AuthEnv,
  userId: string,
  input: { userAgent?: string; now?: number } = {}
): Promise<{ token: string; expiresAt: number; cookieName: string }> {
  const now = input.now ?? Date.now();
  const token = randomToken(32);
  const id = await sessionIdFor(env, token);
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ua_hash) VALUES (?,?,?,?,?,?)'
  )
    .bind(id, userId, now, expiresAt, (input.userAgent ?? '').slice(0, 200), await hmacHex(env.SESSION_SECRET, input.userAgent ?? ''))
    .run();

  return { token, expiresAt, cookieName: sessionCookieName(env.AUTH_ISSUER) };
}

/** Resolve a session cookie into a full context, or null when absent/invalid/expired. */
export async function resolveSession(
  env: AuthEnv,
  request: Request,
  cookieToken: string | undefined
): Promise<SessionContext | null> {
  if (!cookieToken) return null;
  const id = await sessionIdFor(env, cookieToken);
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  const userRow = await findUserById(env, row.user_id);
  if (!userRow || userRow.status !== 'active') return null;

  // Bind the session to the user agent that created it. A stolen cookie is
  // useless from a different client.
  const uaHash = await hmacHex(env.SESSION_SECRET, request.headers.get('user-agent') ?? '');
  const storedUa = await env.DB.prepare('SELECT ua_hash FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ ua_hash: string }>();
  if (storedUa && storedUa.ua_hash !== '' && !constantTimeEqual(storedUa.ua_hash, uaHash)) {
    return null;
  }

  return {
    sessionToken: cookieToken,
    sessionId: id,
    user: toPublicUser(userRow),
    userRow,
    csrfToken: await csrfTokenFor(env, cookieToken)
  };
}

export async function destroySession(env: AuthEnv, cookieToken: string | undefined): Promise<void> {
  if (!cookieToken) return;
  const id = await sessionIdFor(env, cookieToken);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/** Invalidate every session for an account (used on password change). */
export async function destroyAllSessions(env: AuthEnv, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function csrfTokenFor(env: AuthEnv, sessionToken: string): Promise<string> {
  return hmacHex(env.SESSION_SECRET, `csrf:${sessionToken}`);
}

export async function verifyCsrf(env: AuthEnv, context: SessionContext, provided: string | null): Promise<boolean> {
  if (!provided) return false;
  const expected = await csrfTokenFor(env, context.sessionToken);
  return constantTimeEqual(expected, provided);
}

export async function purgeExpiredSessions(env: AuthEnv, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  return result.meta?.changes ?? 0;
}
