/**
 * MCP server construction.
 *
 * A fresh `McpServer` is built per request. That is the right shape for a
 * stateless Streamable HTTP resource server:
 *
 *  - No cross-tenant state can leak between requests, because there is none.
 *  - The upstream server fetched website settings once at startup and baked them
 *    into its instructions. That only works for a single-site, single-user stdio
 *    process; a hosted server serves many accounts and sites, so instructions
 *    stay static and site context is fetched per call.
 *
 * Tools are always registered, including ones the current token cannot use.
 * That is deliberate: MCP scope step-up works by the client attempting a call
 * and receiving a 403 challenge naming the scopes it needs. A hidden tool could
 * never trigger that challenge, so hiding would only make the server harder to
 * use without making it safer. Enforcement happens in the HTTP pre-flight and
 * again inside each tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools/index.js';
import type { ToolContext } from './tools/context.js';

export const SERVER_NAME = 'bludit-wizard-mcp';
export const SERVER_VERSION = '1.0.0';

export const INSTRUCTIONS = `Bludit Wizard MCP manages Bludit CMS websites on behalf of the signed-in account.

Start with list_sites to see which websites are available. Every tool accepts a \`site\` argument (site id, label, or hostname); when only one site is connected you may omit it, and when several are connected omitting it is an error rather than a guess.

Reading is safe and cheap: list_pages returns summaries, get_page returns one page in full. search_pages is deterministic substring filtering on this server — Bludit exposes no search endpoint — so results depend on how many pages were scanned.

Writing has two paths. create_page and edit_page write immediately and then read the page back to confirm. propose_page_edit records a reviewable, short-lived change pinned to the page's current revision; apply_approved_edit applies it and refuses if the page changed in between. Prefer the proposal path when a human should review the change first.

Page deletion is not available through this server.

Never present a change as applied unless a tool result confirmed it with verified: true.`;

/**
 * Build a server over a context.
 *
 * `options.instructions` exists only because one sentence of the hosted
 * instructions is untrue locally: with a single configured site the `site` argument
 * can never be ambiguous, and proposals live in memory rather than in D1. The
 * difference is a string, not a code path — the tools are registered identically
 * either way.
 */
export function createMcpServer(ctx: ToolContext, options: { instructions?: string } = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: options.instructions ?? INSTRUCTIONS }
  );
  registerTools(server, ctx);
  return server;
}
