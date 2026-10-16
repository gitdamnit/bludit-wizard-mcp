/**
 * Environment and binding contracts for both Workers.
 *
 * The service is deliberately split into two Workers:
 *   - `bludit-wizard-auth`  — authorization server + account/site management UI
 *   - `bludit-wizard-mcp`   — MCP resource server (Streamable HTTP)
 *
 * They share one D1 database. The MCP Worker reaches the authorization server
 * over a private Service Binding to validate access tokens.
 */

import type { AuthorizationServerBinding } from '@cloudflare/workers-oauth-provider';

/** Identity attached to an OAuth grant and carried into the MCP handler as `ctx.props`. */
export interface AuthProps {
  /** Stable identifier of the *account on this service* (never a Bludit username). */
  userId: string;
  /** Account email, for display only. */
  email: string;
  /** Account display name, for display only. */
  displayName: string;
  /** Encryption key version used for site credentials at the time of consent. */
  credentialKeyVersion: number;
}

/**
 * Configuration and secrets shared by both Workers.
 *
 * Renamed from `SharedSecrets` once rate limiting added non-secret variables
 * here: a name that calls every field a secret invites treating them all as one.
 */
export interface SharedConfig {
  /**
   * base64 of 32 random bytes. Root key for encrypting Bludit credentials at rest.
   * Managed as a Worker secret; never stored in D1 and never logged.
   */
  SITE_CREDENTIAL_KEY: string;
  /** Optional var to force a key-rotation generation number. */
  CREDENTIAL_KEY_VERSION?: string;
  /** `"true"` permits `http://` site URLs for loopback hosts only. Development use. */
  ALLOW_INSECURE_SITE_URLS?: string;
  /** Lifetime of a pairing challenge in seconds. */
  PAIRING_TTL_SECONDS?: string;
  /** Lifetime of a proposal in seconds. */
  PROPOSAL_TTL_SECONDS?: string;

  /**
   * Set to `"false"` to disable rate limiting entirely. Intended for local
   * development and for tests that are not about rate limiting.
   */
  RATE_LIMIT_ENABLED?: string;
  /** Per-bucket overrides in `"<limit>/<windowSeconds>"` form. See rate-limit.ts. */
  RL_SIGNIN?: string;
  RL_AUTHORIZE?: string;
  RL_TOKEN?: string;
  RL_REGISTER?: string;
  RL_PAIRING?: string;
  RL_CONNECT?: string;
  RL_MCP?: string;
}

export interface AuthEnv extends SharedConfig {
  /** KV namespace owned by the OAuth provider: clients, grants, codes, tokens. */
  OAUTH_KV: KVNamespace;
  /** D1: accounts, sessions, sites, pairing challenges, proposals, audit log. */
  DB: D1Database;
  /** Public issuer URL of the authorization server, e.g. `https://mcp.evanzellner.com`. */
  AUTH_ISSUER: string;
  /** Canonical MCP resource identifier, e.g. `https://mcp.evanzellner.com/mcp`. */
  MCP_RESOURCE: string;
  /** HMAC key (>= 32 chars) for session cookies and pairing-challenge hashing. */
  SESSION_SECRET: string;
  /** HMAC key (>= 32 chars) for the remembered-consent cookie. */
  CONSENT_SECRET: string;
  /** PBKDF2-SHA256 iteration count for account passwords. See docs/DEPLOYMENT.md. */
  PBKDF2_ITERATIONS?: string;
  /** Set to `"false"` to disable self-service account creation. */
  ALLOW_SIGNUP?: string;
}

export interface McpEnv extends SharedConfig {
  DB: D1Database;
  /**
   * Private RPC binding to the authorization server Worker's `validateToken`.
   * Typed as the library's `AuthorizationServerBinding` so the method signature
   * is checked at compile time rather than discovered at runtime.
   */
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  AUTH_ISSUER: string;
  MCP_RESOURCE: string;
}

/** Read a positive integer var with a default. */
export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Normalize a URL var by removing any trailing slash. */
export function trimBase(value: string): string {
  return value.replace(/\/+$/, '');
}

export const DEFAULT_PAIRING_TTL_SECONDS = 15 * 60;
export const DEFAULT_PROPOSAL_TTL_SECONDS = 15 * 60;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
