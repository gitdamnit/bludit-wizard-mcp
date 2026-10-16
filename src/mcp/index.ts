/**
 * MCP resource server Worker entry.
 *
 * Exported as a plain handler because the resource server has no RPC surface of
 * its own: it only consumes the authorization server's `validateToken`.
 */

import { createResourceServer } from './app.js';
import { logger } from '../shared/log.js';
import { purgeExpiredRateLimits } from '../shared/rate-limit.js';
import { expireStaleProposals } from '../proposals/store.js';
import type { McpEnv } from '../shared/env.js';

export default {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    return createResourceServer(env).fetch(request, env, ctx);
  },

  /**
   * Prune expired proposal records and rate-limit windows. This Worker writes to
   * both tables, so it owns their cleanup; the authorization server prunes the
   * ones it owns.
   */
  async scheduled(_controller: ScheduledController, env: McpEnv): Promise<void> {
    const [proposals, rateLimits] = await Promise.all([
      expireStaleProposals(env.DB),
      purgeExpiredRateLimits(env.DB)
    ]);
    logger.info('mcp.cleanup', { proposals, rateLimits });
  }
};
