/**
 * MCP resource server Worker entry.
 *
 * Exported as a plain handler because the resource server has no RPC surface of
 * its own: it only consumes the authorization server's `validateToken`.
 */

import { createResourceServer } from './app.js';
import type { McpEnv } from '../shared/env.js';

export default {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    return createResourceServer(env).fetch(request, env, ctx);
  }
};
