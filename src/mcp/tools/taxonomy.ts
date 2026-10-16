/**
 * Taxonomy read tools. Real CMS actions over the Bludit API.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BluditTaxonomyTerm } from '../../bludit/types.js';
import { requireToolScope, siteFor, withAudit, type ToolContext } from './context.js';
import { toResult } from './result.js';

function summarizeTerm(term: BluditTaxonomyTerm): {
  key: string;
  name: string;
  description: string;
  pageCount: number | null;
} {
  return {
    key: String(term.key ?? ''),
    name: String(term.name ?? term.key ?? ''),
    description: String(term.description ?? ''),
    pageCount: Array.isArray(term.pages) ? term.pages.length : null
  };
}

export function registerTaxonomyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'List the categories defined on a Bludit site, with their name, description and page count. Bludit reindexes categories automatically when a page is created or edited, so this reflects the site after the last write.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site }) =>
      toResult(() =>
        withAudit(ctx, 'list_categories', async () => {
          requireToolScope(ctx, 'list_categories');
          const resolved = await siteFor(ctx, site);
          const categories = (await resolved.client.listCategories()).map(summarizeTerm);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              count: categories.length,
              categories
            }
          };
        })
      )
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'List the tags in use on a Bludit site, with their name, description and page count.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site }) =>
      toResult(() =>
        withAudit(ctx, 'list_tags', async () => {
          requireToolScope(ctx, 'list_tags');
          const resolved = await siteFor(ctx, site);
          const tags = (await resolved.client.listTags()).map(summarizeTerm);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              count: tags.length,
              tags
            }
          };
        })
      )
  );
}
