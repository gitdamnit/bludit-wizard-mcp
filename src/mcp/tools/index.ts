import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerSiteTools } from './sites.js';
import { registerPageTools } from './pages.js';
import { registerTaxonomyTools } from './taxonomy.js';
import { registerIntelligenceTools } from './intelligence.js';
import { registerWriteTools } from './write.js';

/**
 * Register every tool. Each module owns one concern so it can be tested on its
 * own with a fake context.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerSiteTools(server, ctx);
  registerPageTools(server, ctx);
  registerTaxonomyTools(server, ctx);
  registerIntelligenceTools(server, ctx);
  registerWriteTools(server, ctx);
}

export type { ToolContext };
