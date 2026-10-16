/**
 * Page read tools.
 *
 * All are real CMS actions against the Bludit API. `list_pages` deliberately
 * returns page *summaries* rather than full page objects: the upstream server
 * returned every field including the rendered body, which is expensive in a
 * model's context window and unnecessary for listing. Full content is one
 * `get_page` call away.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pageRevision } from '../../bludit/client.js';
import type { BluditPage } from '../../bludit/types.js';
import { requireToolScope, siteFor, withAudit, type ToolContext } from './context.js';
import { toResult, truncate } from './result.js';

export interface PageSummary {
  key: string;
  title: string;
  description: string;
  type: string;
  slug: string;
  date: string;
  tags: string[];
  category: string;
  permalink: string;
}

export function summarizePage(page: BluditPage): PageSummary {
  return {
    key: page.key,
    title: page.title ?? '',
    description: page.description ?? '',
    type: page.type ?? '',
    slug: page.slug ?? '',
    date: page.dateRaw ?? page.date ?? '',
    tags: Array.isArray(page.tags) ? page.tags : [],
    category: page.category ?? '',
    permalink: page.permalink ?? ''
  };
}

const typeFilters = {
  published: z.boolean().optional().describe('Include published pages. Default true.'),
  static: z.boolean().optional().describe('Include static pages. Default false.'),
  sticky: z.boolean().optional().describe('Include sticky pages. Default false.'),
  draft: z.boolean().optional().describe('Include draft pages. Default false.'),
  scheduled: z.boolean().optional().describe('Include scheduled pages. Default false.'),
  untagged: z.boolean().optional().describe('Restrict to pages with no tags. Applied after the page slice on the server.')
};

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_website_settings',
    {
      title: 'Get website settings',
      description:
        'Read the site configuration Bludit exposes over its API: site title, description, language, timezone and URL. Requires the `settings:read` scope and a stored user auth token, because Bludit itself gates this endpoint behind an authenticated admin.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site }) =>
      toResult(() =>
        withAudit(ctx, 'get_website_settings', async () => {
          requireToolScope(ctx, 'get_website_settings');
          const resolved = await siteFor(ctx, site);
          const settings = await resolved.client.getSettings();
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              settings
            }
          };
        })
      )
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description:
        'List pages on a Bludit site with type filters and pagination. Returns summaries (key, title, description, type, slug, date, tags, category, permalink) plus the API pagination meta. Use `get_page` for the full body.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        ...typeFilters,
        pageNumber: z.number().int().min(1).optional().describe('1-indexed page number. Default 1.'),
        numberOfItems: z
          .number()
          .int()
          .optional()
          .describe('Page size. -1 returns every matching page. Defaults to the site API plugin setting (usually 15).')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async (args) =>
      toResult(() =>
        withAudit(ctx, 'list_pages', async () => {
          requireToolScope(ctx, 'list_pages');
          const resolved = await siteFor(ctx, args.site);
          const envelope = await resolved.client.listPages({
            published: args.published,
            static: args.static,
            sticky: args.sticky,
            draft: args.draft,
            scheduled: args.scheduled,
            pageNumber: args.pageNumber,
            numberOfItems: args.numberOfItems
          });

          let pages = (envelope.data ?? []).map(summarizePage);
          if (args.untagged === true) pages = pages.filter((page) => page.tags.length === 0);

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              count: pages.length,
              meta: envelope.meta ?? null,
              pages,
              note:
                args.untagged === true
                  ? 'The `untagged` filter is applied to this page of results only; `meta.total` still counts all matching pages.'
                  : undefined
            }
          };
        })
      )
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get a page',
      description:
        'Read one page in full, including its raw Markdown, the rendered HTML, its revision identifier and its metadata. The revision identifier is what `propose_page_edit` and `apply_approved_edit` compare against to detect a page that changed underneath you.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe("Page key, for example 'about' or 'parent/child'.")
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, key }) =>
      toResult(() =>
        withAudit(ctx, 'get_page', async () => {
          requireToolScope(ctx, 'get_page');
          const resolved = await siteFor(ctx, site);
          const page = await resolved.client.getPage(key);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              revision: await pageRevision(page),
              page: {
                key: page.key,
                title: page.title ?? '',
                description: page.description ?? '',
                type: page.type ?? '',
                slug: page.slug ?? '',
                date: page.dateRaw ?? page.date ?? '',
                dateUTC: page.dateUTC ?? '',
                tags: page.tags ?? [],
                category: page.category ?? '',
                username: page.username ?? '',
                uuid: page.uuid ?? '',
                permalink: page.permalink ?? '',
                contentRaw: page.contentRaw ?? page.content ?? '',
                contentHtml: page.content ?? ''
              },
              contentTruncated: false
            }
          };
        })
      )
  );

  server.registerTool(
    'get_drafts',
    {
      title: 'List drafts',
      description: 'List draft pages on a Bludit site. Convenience wrapper over `list_pages` with `draft` enabled.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        numberOfItems: z.number().int().optional().describe('Page size. -1 returns all drafts. Default 15.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, numberOfItems }) =>
      toResult(() =>
        withAudit(ctx, 'get_drafts', async () => {
          requireToolScope(ctx, 'get_drafts');
          const resolved = await siteFor(ctx, site);
          const envelope = await resolved.client.listPages({
            published: false,
            draft: true,
            numberOfItems: numberOfItems ?? -1
          });
          const pages = (envelope.data ?? []).map(summarizePage);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              count: pages.length,
              pages
            }
          };
        })
      )
  );

  server.registerTool(
    'get_scheduled_pages',
    {
      title: 'List scheduled pages',
      description:
        'List pages scheduled for future publication. Bludit stores a scheduled page as type `scheduled` with a future `date`, and promotes it to `published` once that date passes.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        numberOfItems: z.number().int().optional().describe('Page size. -1 returns all scheduled pages. Default -1.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, numberOfItems }) =>
      toResult(() =>
        withAudit(ctx, 'get_scheduled_pages', async () => {
          requireToolScope(ctx, 'get_scheduled_pages');
          const resolved = await siteFor(ctx, site);
          const envelope = await resolved.client.listPages({
            published: false,
            scheduled: true,
            numberOfItems: numberOfItems ?? -1
          });
          const pages = (envelope.data ?? []).map(summarizePage);
          const now = new Date();
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              count: pages.length,
              pages: pages
                .map((page) => ({ ...page, scheduledFor: page.date, isFuture: page.date ? page.date > formatBluditDate(now) : null }))
                .sort((a, b) => a.date.localeCompare(b.date))
            }
          };
        })
      )
  );
}

/** Bludit's DB date format is `YYYY-MM-DD HH:MM:SS`. */
export function formatBluditDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes()
  )}:${pad(date.getUTCSeconds())}`;
}

export function summarizeForContext(page: BluditPage, maxChars = 1800): string {
  const raw = page.contentRaw ?? page.content ?? '';
  return truncate(raw.replace(/\s+/g, ' '), maxChars);
}
