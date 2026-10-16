/**
 * Deterministic content intelligence.
 *
 * None of these tools call a model. They are pure, reproducible transformations
 * over page data fetched from the CMS, and they are labelled as such in the
 * tool descriptions so a client never mistakes them for inference.
 *
 * The official Bludit API has no search endpoint, so `search_pages` filters the
 * page list on this server. That is a real limitation, stated plainly in the
 * response rather than hidden.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BluditPage } from '../../bludit/types.js';
import { ToolError } from '../../shared/errors.js';
import { pageCategory, pageTags } from '../../bludit/client.js';
import { requireToolScope, siteFor, withAudit, type ToolContext } from './context.js';
import { summarizePage, type PageSummary } from './pages.js';
import { toResult, truncate } from './result.js';

const DEFAULT_SCAN_LIMIT = 200;
const MAX_SCAN_LIMIT = 500;

/**
 * Upper bound on pages fetched individually when `include_content` is set.
 *
 * Each fetched page is a separate subrequest, and a Workers request may make only
 * 50 subrequests on the Free plan (10,000 on Paid) — including D1 queries. The
 * default leaves headroom for the list call, the audit write and the platform's
 * own bookkeeping. A Paid deployment can safely raise this constant.
 */
const MAX_CONTENT_SCAN = 40;

export function registerIntelligenceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_pages',
    {
      title: 'Search pages',
      description:
        'Search pages by substring. This is deterministic filtering on the MCP server, not a CMS-side search: the official Bludit API exposes no search endpoint. Fields searched default to key, title, description, slug, tags and category. Set `include_content` to also match page bodies, which fetches each candidate page and is therefore bounded by `scan_limit`.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        query: z.string().min(1).describe('Case-insensitive substring to look for.'),
        include_content: z
          .boolean()
          .optional()
          .describe(
            `Also match against each page body. Each page is a separate upstream request, so scan_limit is limited to ${40} when this is set. Default false.`
          ),
        published: z.boolean().optional().describe('Search published pages. Default true.'),
        draft: z.boolean().optional().describe('Also search drafts. Default false.'),
        static: z.boolean().optional().describe('Also search static pages. Default false.'),
        sticky: z.boolean().optional().describe('Also search sticky pages. Default false.'),
        scheduled: z.boolean().optional().describe('Also search scheduled pages. Default false.'),
        scan_limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SCAN_LIMIT)
          .optional()
          .describe(`Maximum pages to consider. Default ${DEFAULT_SCAN_LIMIT}, maximum ${MAX_SCAN_LIMIT}.`),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum matches to return. Default 20.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async (args) =>
      toResult(() =>
        withAudit(ctx, 'search_pages', async () => {
          requireToolScope(ctx, 'search_pages');
          const resolved = await siteFor(ctx, args.site);
          const requested = args.scan_limit ?? DEFAULT_SCAN_LIMIT;

          // Refuse rather than silently clamp: a caller asking to scan 200 pages
          // with `include_content` needs to know why it cannot.
          if (args.include_content === true && requested > MAX_CONTENT_SCAN) {
            throw new ToolError(
              'invalid_input',
              `Scanning page bodies is limited to ${MAX_CONTENT_SCAN} pages per call, because each page is a separate upstream request. Lower scan_limit, or omit include_content to search titles and descriptions only.`,
              { requestedScanLimit: requested, maxContentScan: MAX_CONTENT_SCAN }
            );
          }

          const scanLimit = Math.min(requested, MAX_SCAN_LIMIT);
          const resultLimit = args.limit ?? 20;
          const needle = args.query.toLowerCase();

          const envelope = await resolved.client.listPages({
            published: args.published ?? true,
            draft: args.draft,
            static: args.static,
            sticky: args.sticky,
            scheduled: args.scheduled,
            numberOfItems: scanLimit
          });
          const candidates = envelope.data ?? [];

          const matches: Array<PageSummary & { matchedIn: string[]; excerpt?: string }> = [];
          for (const page of candidates) {
            const matchedIn: string[] = [];
            if ((page.key ?? '').toLowerCase().includes(needle)) matchedIn.push('key');
            if ((page.title ?? '').toLowerCase().includes(needle)) matchedIn.push('title');
            if ((page.description ?? '').toLowerCase().includes(needle)) matchedIn.push('description');
            if ((page.slug ?? '').toLowerCase().includes(needle)) matchedIn.push('slug');
            if (pageCategory(page).toLowerCase().includes(needle)) matchedIn.push('category');
            if (pageTags(page).some((tag) => tag.toLowerCase().includes(needle))) matchedIn.push('tags');

            let excerpt: string | undefined;
            if (args.include_content === true) {
              const full = await resolved.client.getPage(page.key);
              const raw = full.contentRaw ?? full.content ?? '';
              const index = raw.toLowerCase().indexOf(needle);
              if (index >= 0) {
                matchedIn.push('content');
                excerpt = truncate(raw.slice(Math.max(0, index - 120), index + 240).replace(/\s+/g, ' '), 400);
              }
            }

            if (matchedIn.length > 0) {
              matches.push({ ...summarizePage(page), matchedIn, ...(excerpt ? { excerpt } : {}) });
              if (matches.length >= resultLimit) break;
            }
          }

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              query: args.query,
              scanned: candidates.length,
              scanLimit,
              truncatedScan: candidates.length >= scanLimit,
              count: matches.length,
              matches,
              method: 'deterministic_substring_filter',
              note:
                'Server-side substring filtering. Bludit provides no search endpoint, so results depend on `scan_limit`; raise it to search more pages.'
            }
          };
        })
      )
  );

  server.registerTool(
    'get_content_summary',
    {
      title: 'Summarize page content',
      description:
        'Produce deterministic statistics about a page: word count, reading time, heading outline, link and image counts, and whether a description is present. No model is involved — these are counts and extracted Markdown headings.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe('Page key to summarize.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, key }) =>
      toResult(() =>
        withAudit(ctx, 'get_content_summary', async () => {
          requireToolScope(ctx, 'get_content_summary');
          const resolved = await siteFor(ctx, site);
          const page = await resolved.client.getPage(key);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              pageKey: page.key,
              summary: summarizeContent(page)
            }
          };
        })
      )
  );

  server.registerTool(
    'get_related_pages',
    {
      title: 'Find related pages',
      description:
        'Rank other pages on the site by deterministic similarity to a given page: shared tags, shared category, and shared significant title words. No model, no embeddings. Useful for building internal links and spotting near-duplicates.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe('Page key to find relatives of.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results. Default 10.'),
        scan_limit: z.number().int().min(1).max(MAX_SCAN_LIMIT).optional().describe('Maximum pages to compare against.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    async ({ site, key, limit, scan_limit }) =>
      toResult(() =>
        withAudit(ctx, 'get_related_pages', async () => {
          requireToolScope(ctx, 'get_related_pages');
          const resolved = await siteFor(ctx, site);
          const scanLimit = Math.min(scan_limit ?? DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);

          const target = await resolved.client.getPage(key);
          const envelope = await resolved.client.listPages({
            published: true,
            draft: true,
            static: true,
            sticky: true,
            scheduled: true,
            numberOfItems: scanLimit
          });

          const targetTags = new Set(pageTags(target).map((tag) => tag.toLowerCase()));
          const targetWords = significantWords(`${target.title ?? ''} ${target.description ?? ''}`);
          const targetCategory = pageCategory(target).toLowerCase();

          const scored = (envelope.data ?? [])
            .filter((page) => page.key !== target.key)
            .map((page) => {
              const reasons: string[] = [];
              let score = 0;
              const sharedTags = pageTags(page).filter((tag) => targetTags.has(tag.toLowerCase()));
              if (sharedTags.length > 0) {
                score += sharedTags.length * 3;
                reasons.push(`shared tags: ${sharedTags.join(', ')}`);
              }
              if (targetCategory !== '' && pageCategory(page).toLowerCase() === targetCategory) {
                score += 2;
                reasons.push(`same category: ${page.category}`);
              }
              const words = significantWords(`${page.title ?? ''} ${page.description ?? ''}`);
              const sharedWords = [...words].filter((word) => targetWords.has(word));
              if (sharedWords.length > 0) {
                score += sharedWords.length;
                reasons.push(`shared title/description words: ${sharedWords.slice(0, 6).join(', ')}`);
              }
              return { page: summarizePage(page), score, reasons };
            })
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.page.key.localeCompare(b.page.key))
            .slice(0, limit ?? 10);

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              pageKey: target.key,
              comparedAgainst: (envelope.data ?? []).length,
              count: scored.length,
              related: scored.map((entry) => ({
                ...entry.page,
                score: entry.score,
                reasons: entry.reasons
              })),
              method: 'deterministic_tag_category_word_overlap'
            }
          };
        })
      )
  );
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was', 'were', 'have', 'has',
  'how', 'why', 'what', 'when', 'who', 'not', 'but', 'all', 'any', 'can', 'our', 'its', 'it', 'of', 'to',
  'in', 'on', 'at', 'by', 'as', 'is', 'be', 'or', 'an', 'a'
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
  );
}

export interface ContentSummary {
  words: number;
  characters: number;
  lines: number;
  readingMinutes: number;
  headings: Array<{ level: number; text: string }>;
  links: number;
  images: number;
  hasDescription: boolean;
  hasTitle: boolean;
  /** Markdown constructs worth flagging before publishing. */
  warnings: string[];
}

export function summarizeContent(page: BluditPage): ContentSummary {
  const raw = page.contentRaw ?? page.content ?? '';
  const words = raw.split(/\s+/).filter((token) => token.trim() !== '').length;
  const headings: Array<{ level: number; text: string }> = [];
  for (const line of raw.split('\n')) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (match) headings.push({ level: (match[1] as string).length, text: (match[2] as string).trim() });
  }

  const warnings: string[] = [];
  if ((page.description ?? '').trim() === '') warnings.push('No description set.');
  if (headings.length === 0) warnings.push('No Markdown headings found.');
  if (words < 80) warnings.push('Content is short (under 80 words).');
  if (/\{\{|\}\}/.test(raw)) warnings.push('Content contains template-like braces.');

  return {
    words,
    characters: raw.length,
    lines: raw.split('\n').length,
    readingMinutes: Math.max(1, Math.round(words / 200)),
    headings: headings.slice(0, 100),
    links: (raw.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length - (raw.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    images: (raw.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length,
    hasDescription: (page.description ?? '').trim() !== '',
    hasTitle: (page.title ?? '').trim() !== '',
    warnings
  };
}
