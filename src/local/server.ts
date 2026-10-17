/**
 * The local stdio MCP server.
 *
 * It is the *same* `createMcpServer` the hosted transport uses, given a different
 * context. Nothing about the nineteen tools, their schemas or their safety rules is
 * re-implemented here — that is the entire point of the extraction.
 *
 * The instructions differ in two places, and only where the truth differs:
 *
 *  - There is exactly one site, so the `site` argument is always optional and can
 *    never be ambiguous.
 *  - Proposals are held in memory (decision D-0004), so a proposal does not survive
 *    a restart. A client that is told this will re-propose; one that is not will
 *    report a bug.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../mcp/server.js';
import type { LocalConfig } from './config.js';
import { buildLocalToolContext, type LocalContextOptions } from './context.js';

export const LOCAL_INSTRUCTIONS = `Bludit Wizard MCP manages a single Bludit CMS website, the one this installation was configured with, running on your own computer.

Every tool accepts an optional \`site\` argument, but there is only one site, so you can always omit it. list_sites returns that site and its cached capability report.

Reading is safe and cheap: list_pages returns summaries, get_page returns one page in full. search_pages is deterministic substring filtering on this server — Bludit exposes no search endpoint — so results depend on how many pages were scanned.

Writing has two paths. create_page and edit_page write immediately and then read the page back to confirm. propose_page_edit records a reviewable, short-lived change pinned to the page's current revision; apply_approved_edit applies it and refuses if the page changed in between. Prefer the proposal path when a human should review the change first. Proposals are kept in memory and do not survive a restart of this server; if one is lost, propose the change again.

Page deletion is not available through this server.

Never present a change as applied unless a tool result confirmed it with verified: true.`;

export function createLocalServer(config: LocalConfig, options: LocalContextOptions = {}): McpServer {
  const ctx = buildLocalToolContext(config, options);
  return createMcpServer(ctx, { instructions: LOCAL_INSTRUCTIONS });
}

/** Re-exported so the entry point and tests build the server the same way. */
export { buildLocalToolContext };
