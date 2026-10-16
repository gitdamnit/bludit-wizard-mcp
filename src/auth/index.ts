/**
 * Authorization server Worker.
 *
 * Exported as a `WorkerEntrypoint` so the MCP resource Worker can reach
 * `validateToken` over a private Service Binding. That binding is the only
 * cross-Worker trust path in the system: the resource server never re-implements
 * token validation, and the authorization server never needs to be publicly
 * reachable from the resource server's own origin.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { createAuthApp } from './app.js';
import { createAuthorizationServer } from './oauth.js';
import { logger } from '../shared/log.js';
import { purgeExpiredSessions } from './sessions.js';
import { purgeExpiredChallenges } from '../sites/pairing.js';
import { expireStaleProposals } from '../proposals/store.js';
import type { AuthEnv } from '../shared/env.js';

/** Paths served by this application rather than by the OAuth library. */
const APP_PREFIXES = ['/signin', '/signup', '/signout', '/authorize', '/sites', '/clients', '/healthz'] as const;

export function isApplicationRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return APP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default class AuthServer extends WorkerEntrypoint<AuthEnv> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (isApplicationRoute(pathname)) {
      return createAuthApp(this.env).fetch(request, this.env, this.ctx);
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

  /** Periodic cleanup of expired sessions, challenges and proposals. */
  override async scheduled(): Promise<void> {
    const [sessions, challenges, proposals] = await Promise.all([
      purgeExpiredSessions(this.env),
      purgeExpiredChallenges(this.env.DB),
      expireStaleProposals(this.env.DB)
    ]);
    logger.info('auth.cleanup', { sessions, challenges, proposals });
  }
}
