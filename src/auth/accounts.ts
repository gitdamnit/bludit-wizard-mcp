/**
 * Accounts on this service.
 *
 * These are *not* Bludit accounts and *not* OAuth clients. An account is a
 * person who has signed up here and may connect Bludit sites to it. OAuth
 * grants reference `users.id` as their subject, which is what keeps identity,
 * client identity, and site ownership as three separate concepts.
 */

import { ToolError } from '../shared/errors.js';
import { newId } from '../shared/crypto.js';
import { hashPassword, verifyPassword } from '../shared/crypto.js';
import { DEFAULT_PBKDF2_ITERATIONS, intVar, type AuthEnv } from '../shared/env.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export function pbkdf2Iterations(env: AuthEnv): number {
  return intVar(env.PBKDF2_ITERATIONS, DEFAULT_PBKDF2_ITERATIONS);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new ToolError('invalid_input', 'Enter a valid email address.');
  }
}

/** Minimum policy: 12 characters. Length beats composition rules. */
export function assertAcceptablePassword(password: string): void {
  if (password.length < 12) {
    throw new ToolError('invalid_input', 'Password must be at least 12 characters.');
  }
  if (password.length > 512) {
    throw new ToolError('invalid_input', 'Password is too long.');
  }
}

export async function findUserByEmail(env: AuthEnv, email: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .bind(normalizeEmail(email))
    .first<UserRow>();
}

export async function findUserById(env: AuthEnv, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function countUsers(env: AuthEnv): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createUser(
  env: AuthEnv,
  input: { email: string; password: string; displayName?: string; allowDuplicate?: boolean }
): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  assertValidEmail(email);
  assertAcceptablePassword(input.password);

  if (!input.allowDuplicate) {
    const existing = await findUserByEmail(env, email);
    if (existing) {
      throw new ToolError('conflict', 'An account with that email already exists.');
    }
  }

  const now = Date.now();
  const row: UserRow = {
    id: newId('user'),
    email,
    display_name: (input.displayName ?? '').trim().slice(0, 120),
    password_hash: await hashPassword(input.password, pbkdf2Iterations(env)),
    status: 'active',
    created_at: now,
    updated_at: now
  };

  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(row.id, row.email, row.display_name, row.password_hash, row.status, row.created_at, row.updated_at)
    .run();

  return row;
}

/**
 * Verify credentials. Returns null for a wrong password *and* for an unknown
 * email, so the caller cannot distinguish the two.
 *
 * When the account does not exist, a dummy verification still runs so the
 * response time does not leak account existence.
 */
export async function authenticate(env: AuthEnv, email: string, password: string): Promise<UserRow | null> {
  const user = await findUserByEmail(env, email);
  if (!user) {
    await verifyPassword(password, `pbkdf2-sha256$${pbkdf2Iterations(env)}$${'AAAAAAAAAAAAAAAAAAAAAA'}$${'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}`);
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  if (user.status !== 'active') return null;
  return user;
}

export async function setPassword(env: AuthEnv, userId: string, password: string): Promise<void> {
  assertAcceptablePassword(password);
  const hash = await hashPassword(password, pbkdf2Iterations(env));
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(hash, Date.now(), userId)
    .run();
}
