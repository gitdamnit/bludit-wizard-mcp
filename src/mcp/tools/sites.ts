/**
 * Site-level tools.
 *
 * These are deterministic transformations over this service's own data
 * (the D1 site registry) and its capability cache. They never mutate a Bludit
 * site.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectCapabilities } from '../../bludit/capabilities.js';
import { parseCapabilities, updateSiteCapabilities } from '../../sites/registry.js';
import { requireToolScope, resolveSite, siteFor, withAudit, type ToolContext } from './context.js';
import { toResult } from './result.js';

export function registerSiteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_sites',
    {
      title: 'List connected Bludit sites',
      description:
        'List the Bludit websites connected to the signed-in account. Returns metadata only: id, label, base URL, declared edition, connection status and whether the optional Bludit Wizard extension was detected. No credentials, page content or settings are returned.',
      inputSchema: {
        include_capabilities: z
          .boolean()
          .optional()
          .describe('Include the last capability probe result for each site. Default false.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true }
    },
    async ({ include_capabilities }) =>
      toResult(() =>
        withAudit(ctx, 'list_sites', async () => {
          requireToolScope(ctx, 'list_sites');
          const rows = await ctx.db
            .prepare('SELECT * FROM sites WHERE user_id = ? AND status != ? ORDER BY label COLLATE NOCASE')
            .bind(ctx.userId, 'disabled')
            .all<{ id: string; label: string; base_url: string; edition: string; status: string; last_error: string; capabilities_json: string; wizard_api_base: string; wizard_api_key_enc: string; created_at: number; last_checked_at: number }>();

          const sites = (rows.results ?? []).map((row) => ({
            id: row.id,
            label: row.label,
            baseUrl: row.base_url,
            declaredEdition: row.edition,
            status: row.status,
            wizardExtensionDetected: row.wizard_api_base !== '' && row.wizard_api_key_enc !== '',
            lastCheckedAt: row.last_checked_at > 0 ? new Date(row.last_checked_at).toISOString() : null,
            ...(include_capabilities ? { capabilities: parseCapabilities(row.capabilities_json) ?? null } : {})
          }));

          return {
            result: {
              ok: true,
              count: sites.length,
              sites,
              note:
                sites.length > 1
                  ? 'Several sites are connected. Pass the `site` argument (id, label, or hostname) to tools that act on a site.'
                  : undefined
            }
          };
        })
      )
  );

  server.registerTool(
    'select_site',
    {
      title: 'Resolve a site reference',
      description:
        'Resolve a site reference — a site id, an exact label, or a hostname — to one concrete site, and confirm the caller may use it. Use this to disambiguate before a write when several sites are connected. Ambiguous references fail rather than picking one arbitrarily.',
      inputSchema: {
        site: z.string().min(1).describe('Site id, exact label, or hostname (for example `blog.example.com`).')
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true }
    },
    async ({ site }) =>
      toResult(() =>
        withAudit(ctx, 'select_site', async () => {
          requireToolScope(ctx, 'select_site');
          const resolved = await resolveSite(ctx, site);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: {
                id: resolved.row.id,
                label: resolved.row.label,
                baseUrl: resolved.row.base_url,
                declaredEdition: resolved.row.edition,
                status: resolved.row.status
              },
              note: 'Pass this id as the `site` argument to other tools.'
            }
          };
        })
      )
  );

  server.registerTool(
    'get_site_capabilities',
    {
      title: 'Get site capabilities',
      description:
        'Report what a connected Bludit site actually supports: whether the official API plugin is reachable for reads, whether authenticated (write) access works, which endpoints responded, and whether the optional Bludit Wizard PHP extension is installed. Pass `refresh` to re-probe the live site instead of reading the cached result. All probes are reads; nothing is written.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        refresh: z.boolean().optional().describe('Re-probe the live site. Default false, which returns the cached probe.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, refresh }) =>
      toResult(() =>
        withAudit(ctx, 'get_site_capabilities', async () => {
          requireToolScope(ctx, 'get_site_capabilities');
          const resolved = await siteFor(ctx, site);

          let capabilities = parseCapabilities(resolved.row.capabilities_json);
          if (refresh === true || !capabilities) {
            capabilities = await detectCapabilities(resolved.client, {
              declaredEdition: editionOf(resolved.row.edition)
            });
            await updateSiteCapabilities(ctx.db, ctx.userId, resolved.row.id, capabilities);
          }

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              capabilities,
              cached: refresh !== true
            }
          };
        })
      )
  );
}

function editionOf(value: string): 'community' | 'pro' | 'unknown' {
  return value === 'community' || value === 'pro' ? value : 'unknown';
}


