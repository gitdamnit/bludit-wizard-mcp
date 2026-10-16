/**
 * Authorization server Worker.
 *
 * Exported as a `WorkerEntrypoint` so the MCP resource Worker can reach
 * `validateToken` over a private Service Binding. That binding is the only
 * cross-Worker trust path in the system: the resource server never re-implements
 * token validation, and the authorization server never needs to be publicly
 * reachable from the resource server's own origin.
 *
 * This module also guards the protocol endpoints the OAuth library serves. The
 * library parses request bodies itself, so it cannot be wrapped after the fact —
 * the check happens here, before dispatch.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { createAuthApp } from './app.js';
import { createAuthorizationServer } from './oauth.js';
import { logger } from '../shared/log.js';
import { clientIp, enforceRateLimit, purgeExpiredRateLimits } from '../shared/rate-limit.js';
import { purgeExpiredSessions } from './sessions.js';
import { purgeExpiredChallenges } from '../sites/pairing.js';
import { expireStaleProposals } from '../proposals/store.js';
import type { AuthEnv } from '../shared/env.js';

/** Paths served by this application rather than by the OAuth library. */
const APP_PREFIXES = ['/signin', '/signup', '/signout', '/authorize', '/sites', '/clients', '/tokens', '/account', '/healthz'] as const;

export function isApplicationRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return APP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The `client_id` on a token request, when it can be read cheaply and safely.
 *
 * The body is read from a **clone**, so the library still sees an unconsumed
 * request. A body that is absent or larger than the cap is skipped and the
 * request is limited by IP alone, which is weaker but never blocks a legitimate
 * large request.
 */
async function clientIdFromTokenRequest(request: Request): Promise<string | undefined> {
  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > 16_384) return undefined;
  try {
    const form = await request.clone().formData();
    const value = form.get('client_id');
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

export default class AuthServer extends WorkerEntrypoint<AuthEnv> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (isApplicationRoute(pathname)) {
      return createAuthApp(this.env).fetch(request, this.env, this.ctx);
    }

    // Registration spam and token-endpoint abuse are the two protocol endpoints
    // worth bounding, and neither has an account to key on yet.
    if (pathname === '/oauth/register') {
      const limited = await enforceRateLimit(this.env.DB, this.env, 'register', [clientIp(request)], {
        format: 'oauth',
        message: 'Too many client registrations from this address. Please try again later.',
        secret: this.env.SESSION_SECRET
      });
      if (limited) return limited;
    }

    if (pathname === '/oauth/token') {
      const clientId = await clientIdFromTokenRequest(request);
      const limited = await enforceRateLimit(
        this.env.DB,
        this.env,
        'token',
        [clientIp(request), clientId],
        { format: 'oauth', message: 'Too many token requests. Please try again later.', secret: this.env.SESSION_SECRET }
      );
      if (limited) return limited;
    }

    // Discovery, token, revocation and registration are the library's.
    return createAuthorizationServer(this.env).fetch(request, this.env, this.ctx);
  }

  /**
   * Called by the resource server over the Service Binding. Audience and expiry
   * are checked inside the library; a token minted for another resource, or one
   * that has expired, resolves to null.
   */
  validateToken(resource: string, token: string) {
    return createAuthorizationServer(this.env).validateToken(resource, token, this.env);
  }

  /** Periodic cleanup of expired sessions, challenges, proposals and counters. */
  override async scheduled(): Promise<void> {
    const [sessions, challenges, proposals, rateLimits] = await Promise.all([
      purgeExpiredSessions(this.env),
      purgeExpiredChallenges(this.env.DB),
      expireStaleProposals(this.env.DB),
      purgeExpiredRateLimits(this.env.DB)
    ]);
    logger.info('auth.cleanup', { sessions, challenges, proposals, rateLimits });
  }
}
