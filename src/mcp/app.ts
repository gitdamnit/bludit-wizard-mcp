/**
 * MCP resource server.
 *
 * Wraps the MCP handler in `OAuthResourceServer`, which:
 *  - publishes RFC 9728 protected-resource metadata,
 *  - answers unauthenticated requests with a `401` challenge pointing at it,
 *  - validates the bearer token by calling the authorization server over a
 *    private Service Binding, and
 *  - routes only the configured resource and its descendants to the handler.
 *
 * The handler then owns authorization: scope checks, tenancy, and per-call
 * enforcement. A tool call lacking a scope gets an HTTP `403` scope challenge on
 * the same response, naming every scope the operation needs, which is what lets
 * a client step up and re-authorize.
 */

import {
  OAuthResourceServer,
  insufficientScope,
  type OAuthResourceContext
} from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { REQUIRED_SCOPES, hasScopes, scopesForTool } from '../shared/scopes.js';
import { requiredScopesForTools, toolNamesFromBody } from './routing.js';
import { errorSummary, logger } from '../shared/log.js';
import { trimBase, type AuthProps, type McpEnv } from '../shared/env.js';
import { createMcpServer } from './server.js';
import { buildToolContext } from './tools/context.js';

export function createResourceServer(env: McpEnv): OAuthResourceServer<McpEnv, AuthProps> {
  return new OAuthResourceServer<McpEnv, AuthProps>({
    resourceMetadata: {
      resource: env.MCP_RESOURCE,
      authorization_servers: [trimBase(env.AUTH_ISSUER)],
      resource_name: 'Bludit Wizard MCP'
    },
    requiredScopes: [...REQUIRED_SCOPES],
    validateToken: (boundEnv) => boundEnv.AUTH_SERVER.validateToken,
    handler: {
      fetch: handleMcpRequest
    }
  });
}

async function handleMcpRequest(
  request: Request,
  env: McpEnv,
  ctx: OAuthResourceContext<AuthProps>
): Promise<Response> {
  const auth = ctx.auth;

  // Baseline: every operation needs the advertised read scopes.
  if (!hasScopes(auth.scope, REQUIRED_SCOPES)) {
    return insufficientScope(auth, [...REQUIRED_SCOPES], 'This operation requires the baseline read scopes.');
  }

  // Pre-flight the scopes each named tool needs, so the client receives a proper
  // 403 challenge instead of a JSON-RPC error it cannot act on.
  //
  // The challenge names the *complete* scope set the operation requires, not
  // just the difference: MCP clients treat the list as exhaustive and ask for
  // exactly what it says.
  let parsedBody: unknown;
  if (request.method === 'POST') {
    const raw = await request.text();
    if (raw.trim() !== '') {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
          { status: 400 }
        );
      }
    }
    const needed = requiredScopesForTools(toolNamesFromBody(parsedBody));
    if (needed.length > 0 && !hasScopes(auth.scope, needed)) {
      logger.info('mcp.scope.challenge', {
        clientId: auth.clientId,
        userId: auth.userId,
        required: needed.join(' ')
      });
      return insufficientScope(auth, needed, `This operation requires: ${needed.join(' ')}`);
    }
  }

  const toolContext = buildToolContext(env, ctx.props, { scope: auth.scope, clientId: auth.clientId });
  const server = createMcpServer(toolContext);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // `undefined` selects stateless mode: no session id, no session validation,
    // and no in-memory state to leak between tenants.
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, parsedBody === undefined ? {} : { parsedBody });
  } catch (error) {
    logger.error('mcp.request.failed', { ...errorSummary(error) });
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
      { status: 500 }
    );
  } finally {
    // Each request owns its server instance; close it so nothing is retained.
    await server.close().catch(() => undefined);
  }
}

export { scopesForTool };
