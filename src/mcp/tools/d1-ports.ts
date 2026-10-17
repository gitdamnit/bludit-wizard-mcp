/**
 * Cloudflare (D1) implementations of the three ports.
 *
 * These wrap the modules that already existed, so the hosted behaviour is
 * unchanged: same SQL, same scoping by `user_id`, same error codes. The only
 * difference from before the extraction is where the call sits — behind a port
 * instead of inline in a tool.
 *
 * Kept in its own file so that importing the tool context in a local build does
 * not drag the D1-specific code into the module graph any more than necessary.
 */

import { BluditClient } from '../../bludit/client.js';
import type { SiteCapabilities } from '../../bludit/capability-types.js';
import { ToolError } from '../../shared/errors.js';
import type { McpEnv } from '../../shared/env.js';
import { urlPolicyFor } from '../../shared/policy.js';
import { recordAudit } from '../../audit/log.js';
import {
  createProposal,
  getProposal,
  markProposalApplied,
  type CreateProposalInput as StoreCreateInput,
  type ProposalRow
} from '../../proposals/store.js';
import {
  listSiteRows,
  resolveSiteRow,
  updateSiteCapabilities,
  type SiteRow
} from '../../sites/registry.js';
import { toPublicSite } from '../../sites/registry-helpers.js';
import { toBluditCredentials } from '../../sites/credentials.js';
import type {
  AuditEntry,
  AuditSink,
  CreateProposalInput,
  ProposalStore,
  ResolvedSite,
  SiteSource
} from './ports.js';

export function d1SiteSource(env: McpEnv, userId: string): SiteSource {
  async function resolve(reference: string): Promise<ResolvedSite> {
    const row = await resolveSiteRow(env.DB, userId, reference);
    const credentials = await toBluditCredentials(env, row.id, row.base_url, row);
    const client = new BluditClient(credentials, { policy: urlPolicyFor(env) });
    return { row, public: toPublicSite(row), client };
  }

  return {
    list: () => listSiteRows(env.DB, userId),
    resolve,
    async default(): Promise<ResolvedSite> {
      const rows = await listSiteRows(env.DB, userId);
      if (rows.length === 0) {
        throw new ToolError('not_found', 'This account has no connected Bludit sites yet.');
      }
      if (rows.length > 1) {
        throw new ToolError('ambiguous_site', 'Several sites are connected. Name one explicitly with the `site` argument.', {
          available: rows.map((row) => ({ id: row.id, label: row.label, baseUrl: row.base_url }))
        });
      }
      return resolve((rows[0] as SiteRow).id);
    },
    updateCapabilities: (siteId: string, capabilities: SiteCapabilities) =>
      updateSiteCapabilities(env.DB, userId, siteId, capabilities)
  };
}

export function d1AuditSink(db: D1Database, userId: string, clientId: string): AuditSink {
  return {
    async record(entry: AuditEntry): Promise<void> {
      await recordAudit(db, {
        userId,
        clientId,
        siteId: entry.siteId ?? '',
        tool: entry.tool,
        outcome: entry.outcome,
        detail: entry.detail ?? ''
      });
    }
  };
}

/**
 * `ttlSeconds` is passed in rather than read here, because the TTL comes from
 * configuration that only the transport can see.
 */
export function d1ProposalStore(db: D1Database, userId: string, ttlSeconds: number): ProposalStore {
  return {
    async create(input: CreateProposalInput): Promise<{ id: string; expiresAt: number }> {
      const storeInput: StoreCreateInput = {
        userId,
        siteId: input.siteId,
        pageKey: input.pageKey,
        baseRevision: input.baseRevision,
        operation: input.operation,
        payload: input.payload,
        ttlSeconds
      };
      const created = await createProposal(db, storeInput);
      return { id: created.id, expiresAt: created.expiresAt };
    },

    get: (siteId: string, proposalId: string): Promise<ProposalRow> => getProposal(db, userId, siteId, proposalId),

    claim: (proposalId: string, clientId: string): Promise<boolean> =>
      markProposalApplied(db, proposalId, clientId),

    async release(proposalId: string): Promise<void> {
      await db
        .prepare(`UPDATE proposals SET status = 'proposed', applied_at = NULL WHERE id = ? AND status = 'applied'`)
        .bind(proposalId)
        .run();
    },

    ttlSeconds: () => ttlSeconds
  };
}
