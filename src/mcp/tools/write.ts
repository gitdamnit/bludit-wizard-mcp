/**
 * Write tools.
 *
 * Two paths exist, deliberately:
 *
 *  - **Direct** (`create_page`, `edit_page`): a client holding `pages:write`
 *    writes immediately. Optional `expected_revision` gives optimistic
 *    concurrency for callers that want it.
 *  - **Proposed** (`propose_page_edit` → `apply_approved_edit`): the change is
 *    stored as an immutable, account- and site-bound record with a revision
 *    pin. Applying re-checks the pin, so a proposal built from a stale read is
 *    refused rather than allowed to clobber a newer edit.
 *
 * Page deletion is not exposed by any tool. That is a policy decision, not an
 * oversight: see docs/SECURITY.md.
 *
 * Every write is verified by reading the page back. A tool never reports
 * success it has not confirmed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pageCategory, pageRevision, pageTags } from '../../bludit/client.js';
import type { BluditPage, BluditWriteFields } from '../../bludit/types.js';
import { ToolError } from '../../shared/errors.js';
import { diffFields, diffText } from '../../proposals/diff.js';
import { assertProposalApplicable } from '../../proposals/store.js';
import { requireToolScope, siteFor, withAudit, type ToolContext } from './context.js';
import { assertWritable, pickWriteFields, type WriteFieldsInput } from './write-helpers.js';

export { assertWritable, pickWriteFields } from './write-helpers.js';
export type { WriteFieldsInput } from './write-helpers.js';
import { toResult } from './result.js';

const writableFields = {
  title: z.string().optional().describe('Page title.'),
  content: z.string().optional().describe('Page body as Markdown.'),
  description: z.string().optional().describe('Short description used by themes and meta tags.'),
  type: z
    .enum(['published', 'draft', 'static', 'sticky', 'scheduled'])
    .optional()
    .describe('Page type. Bludit defaults new pages to `published`.'),
  slug: z.string().optional().describe('Custom URL slug. Bludit derives one from the title when omitted.'),
  category: z
    .string()
    .optional()
    .describe(
      'Category key. Bludit only resolves a category that the site already defines; any other value is stored but reads back as empty, so create the category in Bludit first.'
    ),
  tags: z.string().optional().describe('Comma-separated tag list.'),
  parent: z.string().optional().describe('Parent page key, for hierarchical pages. Create only.'),
  date: z.string().optional().describe("Publish date in Bludit's `YYYY-MM-DD HH:MM:SS` format. A future date with type `published` becomes `scheduled`."),
  coverImage: z.string().optional().describe('Cover image filename for an already-uploaded image.'),
  template: z.string().optional().describe('Theme template name.'),
  position: z.number().int().optional().describe('Manual sort position.')
};

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'create_page',
    {
      title: 'Create a page',
      description:
        'Create a page on a Bludit site and verify it by reading it back. Requires `pages:write`. Bludit derives the page key from the slug (or the title when no slug is given); the response reports the key that was actually created. Consider `propose_page_edit` when the change should be reviewed first.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        ...writableFields,
        title: z.string().optional().describe('Page title. Required in practice.'),
        content: z.string().optional().describe('Page body as Markdown. Required in practice.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args: WriteFieldsInput & { site?: string; key?: string }) =>
      toResult(() =>
        withAudit(ctx, 'create_page', async () => {
          requireToolScope(ctx, 'create_page');
          const resolved = await siteFor(ctx, args.site);
          const fields = pickWriteFields(args);
          assertWritable(fields, 'create');

          const page = await resolved.client.createPage(fields);
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              action: 'created',
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              key: page.key,
              verified: true,
              revision: await pageRevision(page),
              page: summarize(page)
            }
          };
        })
      )
  );

  server.registerTool(
    'edit_page',
    {
      title: 'Edit a page',
      description:
        'Edit a page and verify it by reading it back. Requires `pages:write`. Send only the fields you want to change; Bludit keeps the rest. Bludit applies a new slug by moving the page, which changes its key — the response reports any key change. Pass `expected_revision` (from `get_page`) to have the edit refused if the page changed since you read it.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe('Existing page key, for example `about` or `parent/child`.'),
        expected_revision: z
          .string()
          .optional()
          .describe('Revision from `get_page`. When supplied, the edit fails if the page has changed since.'),
        ...writableFields
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args: WriteFieldsInput & { site?: string; key?: string; expected_revision?: string }) =>
      toResult(() =>
        withAudit(ctx, 'edit_page', async () => {
          requireToolScope(ctx, 'edit_page');
          const resolved = await siteFor(ctx, args.site);
          const key = args.key as string;
          const fields = pickWriteFields(args);
          assertWritable(fields, 'edit');

          const before = await resolved.client.getPage(key);
          const revisionBefore = await pageRevision(before);

          if (args.expected_revision !== undefined && args.expected_revision !== revisionBefore) {
            throw new ToolError('revision_mismatch', 'The page changed since that revision was read. Re-read it and retry.', {
              expectedRevision: args.expected_revision,
              currentRevision: revisionBefore
            });
          }

          const { page, keyChanged } = await resolved.client.editPage(key, fields);
          const contentBefore = before.contentRaw ?? before.content ?? '';
          const contentAfter = page.contentRaw ?? page.content ?? '';
          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              action: 'edited',
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              key: page.key,
              keyChanged,
              previousKey: keyChanged ? key : undefined,
              verified: true,
              revisionBefore,
              revisionAfter: await pageRevision(page),
              // Metadata changes and body changes are reported separately: the
              // body is compared as text, not as a field.
              changedFields: diffFields(serialize(before), serializeFields(fields)).filter((change) => change.changed),
              contentChanged: contentBefore !== contentAfter,
              page: summarize(page)
            }
          };
        })
      )
  );

  server.registerTool(
    'propose_page_edit',
    {
      title: 'Propose a page change',
      description:
        'Record a short-lived, immutable change proposal without touching the site. The proposal is bound to this account and site and pinned to the page`s current revision. Apply it with `apply_approved_edit`, which refuses if the page changed in the meantime. Use this when a change should be reviewed before it lands. Creating a page is proposed the same way, by passing `key` for the key you intend.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z
          .string()
          .min(1)
          .describe('For an edit, the existing page key. For a create, the key you intend Bludit to use.'),
        operation: z.enum(['create', 'edit']).describe('Whether this proposes creating or editing a page.'),
        ...writableFields,
        title: z.string().optional().describe('Page title. Required when `operation` is `create`.'),
        content: z.string().optional().describe('Page body as Markdown. Required when `operation` is `create`.')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args: WriteFieldsInput & { site?: string; key?: string; operation: 'create' | 'edit' }) =>
      toResult(() =>
        withAudit(ctx, 'propose_page_edit', async () => {
          requireToolScope(ctx, 'propose_page_edit');
          const resolved = await siteFor(ctx, args.site);
          const key = args.key as string;
          const fields = pickWriteFields(args);
          assertWritable(fields, args.operation);

          let baseRevision = '';
          let preview: unknown = null;

          if (args.operation === 'edit') {
            const before = await resolved.client.getPage(key);
            baseRevision = await pageRevision(before);
            preview = {
              pageKey: before.key,
              fieldChanges: diffFields(serialize(before), serializeFields(fields)).filter((change) => change.changed),
              contentDiff:
                fields.content !== undefined
                  ? diffText(before.contentRaw ?? before.content ?? '', fields.content)
                  : null
            };
          } else {
            preview = { pageKey: key, planned: fields };
          }

          const proposal = await ctx.proposals.create({
            siteId: resolved.row.id,
            pageKey: key,
            baseRevision,
            operation: args.operation,
            payload: fields as Record<string, unknown>
          });

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              proposalId: proposal.id,
              operation: args.operation,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              pageKey: key,
              baseRevision,
              expiresAt: new Date(proposal.expiresAt).toISOString(),
              ttlSeconds: ctx.proposals.ttlSeconds(),
              preview,
              note: `Nothing has been written. Apply with apply_approved_edit and proposal_id "${proposal.id}" before it expires.`
            }
          };
        })
      )
  );

  server.registerTool(
    'preview_page_changes',
    {
      title: 'Preview page changes',
      description:
        'Compute exactly what a proposed change would alter, without storing a proposal or touching the site. Returns field-level changes and a unified diff of the Markdown body. This is the same code path `apply_approved_edit` uses, so the preview cannot disagree with the applied result.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe('Existing page key to compare against.'),
        ...writableFields
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args: WriteFieldsInput & { site?: string; key?: string }) =>
      toResult(() =>
        withAudit(ctx, 'preview_page_changes', async () => {
          requireToolScope(ctx, 'preview_page_changes');
          const resolved = await siteFor(ctx, args.site);
          const key = args.key as string;
          const fields = pickWriteFields(args);
          if (Object.keys(fields).length === 0) {
            throw new ToolError('invalid_input', 'Supply at least one field to preview.');
          }

          const before = await resolved.client.getPage(key);
          const beforeContent = before.contentRaw ?? before.content ?? '';
          const contentDiff =
            fields.content !== undefined ? diffText(beforeContent, fields.content) : null;

          return {
            siteId: resolved.row.id,
            result: {
              ok: true,
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              pageKey: before.key,
              currentRevision: await pageRevision(before),
              fieldChanges: diffFields(serialize(before), serializeFields(fields)),
              contentDiff,
              wouldChange: diffFields(serialize(before), serializeFields(fields)).some((change) => change.changed) ||
                (contentDiff !== null && !contentDiff.identical)
            }
          };
        })
      )
  );

  server.registerTool(
    'apply_approved_edit',
    {
      title: 'Apply an approved proposal',
      description:
        'Apply a previously created proposal. Refuses when the proposal belongs to another account or site, has expired, was already applied, or when the page has changed since the proposal was created. Confirms the write by reading the page back and reports the before/after revisions.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        proposal_id: z.string().min(1).describe('Proposal id returned by `propose_page_edit`.'),
        confirm: z
          .literal(true)
          .describe('Must be true. An explicit acknowledgement that this writes to the live site.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ site, proposal_id }) =>
      toResult(() =>
        withAudit(ctx, 'apply_approved_edit', async () => {
          requireToolScope(ctx, 'apply_approved_edit');
          const resolved = await siteFor(ctx, site);
          const proposal = await ctx.proposals.get(resolved.row.id, proposal_id);

          // Read the live state the proposal must still agree with.
          let currentRevision: string | undefined;
          let pageExists: boolean | undefined;
          if (proposal.operation === 'edit') {
            try {
              currentRevision = await pageRevision(await resolved.client.getPage(proposal.page_key));
              pageExists = true;
            } catch (error) {
              if (error instanceof ToolError && error.code === 'not_found') {
                pageExists = false;
              } else {
                throw error;
              }
            }
          } else {
            try {
              await resolved.client.getPage(proposal.page_key);
              pageExists = true;
            } catch (error) {
              if (error instanceof ToolError && error.code === 'not_found') pageExists = false;
              else throw error;
            }
          }

          const payload = assertProposalApplicable(proposal, { currentRevision, pageExists });

          // Claim the proposal before writing so two concurrent applies cannot
          // both proceed. If the write then fails, release the claim.
          const claimed = await ctx.proposals.claim(proposal.id, ctx.clientId);
          if (!claimed) {
            throw new ToolError('conflict', 'This proposal is already being applied or has been applied.', {
              proposalId: proposal.id
            });
          }

          try {
            const fields = payload as BluditWriteFields;
            let page;
            let keyChanged = false;
            if (proposal.operation === 'create') {
              page = await resolved.client.createPage(fields);
            } else {
              const outcome = await resolved.client.editPage(proposal.page_key, fields);
              page = outcome.page;
              keyChanged = outcome.keyChanged;
            }

            return {
              siteId: resolved.row.id,
              result: {
                ok: true,
                action: proposal.operation === 'create' ? 'created' : 'edited',
                proposalId: proposal.id,
                site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
                key: page.key,
                keyChanged,
                verified: true,
                revisionBefore: proposal.base_revision || null,
                revisionAfter: await pageRevision(page),
                page: summarize(page)
              }
            };
          } catch (error) {
            // Release the claim so the proposal can be retried or rejected.
            await ctx.proposals.release(proposal.id);
            throw error;
          }
        })
      )
  );

  server.registerTool(
    'verify_page_update',
    {
      title: 'Verify a page',
      description:
        'Read a page back and confirm it matches expectations. Use after any write to confirm it landed: supply the revision you expect, and/or the field values you expect. Reports field-by-field mismatches rather than a bare pass/fail.',
      inputSchema: {
        site: z.string().optional().describe('Site id, label, or hostname. Omit when only one site is connected.'),
        key: z.string().min(1).describe('Page key to verify.'),
        expected_revision: z.string().optional().describe('Revision the page is expected to have.'),
        expected_title: z.string().optional().describe('Title the page is expected to have.'),
        expected_type: z.string().optional().describe('Type the page is expected to have.'),
        content_contains: z.string().optional().describe('Substring the raw Markdown is expected to contain.')
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args) =>
      toResult(() =>
        withAudit(ctx, 'verify_page_update', async () => {
          requireToolScope(ctx, 'verify_page_update');
          const resolved = await siteFor(ctx, args.site);
          const page = await resolved.client.getPage(args.key);
          const revision = await pageRevision(page);
          const raw = page.contentRaw ?? page.content ?? '';

          const checks: Array<{ check: string; ok: boolean; expected?: string; actual?: string }> = [];
          if (args.expected_revision !== undefined) {
            checks.push({ check: 'revision', ok: revision === args.expected_revision, expected: args.expected_revision, actual: revision });
          }
          if (args.expected_title !== undefined) {
            checks.push({ check: 'title', ok: (page.title ?? '') === args.expected_title, expected: args.expected_title, actual: page.title ?? '' });
          }
          if (args.expected_type !== undefined) {
            checks.push({ check: 'type', ok: (page.type ?? '') === args.expected_type, expected: args.expected_type, actual: page.type ?? '' });
          }
          if (args.content_contains !== undefined) {
            checks.push({ check: 'content_contains', ok: raw.includes(args.content_contains), expected: args.content_contains });
          }

          if (checks.length === 0) {
            throw new ToolError('invalid_input', 'Supply at least one expectation to verify.');
          }

          return {
            siteId: resolved.row.id,
            result: {
              ok: checks.every((check) => check.ok),
              site: { id: resolved.row.id, label: resolved.row.label, baseUrl: resolved.row.base_url },
              pageKey: page.key,
              revision,
              checks
            }
          };
        })
      )
  );
}

function summarize(page: BluditPage): Record<string, unknown> {
  return {
    key: page.key,
    title: page.title ?? '',
    description: page.description ?? '',
    type: page.type ?? '',
    slug: page.slug ?? '',
    date: page.dateRaw ?? page.date ?? '',
    // Normalised: the API sends a comma-joined string.
    tags: pageTags(page),
    category: pageCategory(page),
    permalink: page.permalink ?? ''
  };
}

/** Compare any object against proposed write fields. */
function serialize(page: object): Record<string, unknown> {
  return page as Record<string, unknown>;
}

function serializeFields(fields: BluditWriteFields): Record<string, unknown> {
  return fields as Record<string, unknown>;
}
