/**
 * Local stdio implementations of the three ports.
 *
 * Deliberately minimal, because the threat model is minimal: one user, one site,
 * one process, on that user's own machine.
 *
 *  - **One site, from configuration.** `list` returns it, `default` returns it, and
 *    `resolve` accepts its label or hostname and refuses anything else. There is no
 *    registry, no id lookup against a database, and no way for a tool argument to
 *    select a site the user did not configure.
 *  - **No encryption at rest.** The credentials come from configuration on every
 *    call and are never persisted by this process, so there is nothing to encrypt.
 *    The hosted transport encrypts because it stores them; here there is no store.
 *  - **Proposals in memory.** Same TTL and same revision pin as the hosted store,
 *    held for the life of the process. A restart means re-proposing, which is
 *    documented rather than hidden.
 *  - **Audit on stderr.** One line of JSON per tool call, redacted, so it can never
 *    reach stdout and corrupt the MCP protocol stream.
 */

import { stableHashHex } from '../shared/crypto.js';
import { ToolError } from '../shared/errors.js';
import type { SiteCapabilities } from '../bludit/capability-types.js';
import { BluditClient } from '../bludit/client.js';
import { toPublicSite, type SiteRow } from '../sites/registry-helpers.js';
import type { ProposalRow, ProposalOperation } from '../proposals/store.js';
import type {
  AuditEntry,
  AuditSink,
  CreateProposalInput,
  ProposalStore,
  ResolvedSite,
  SiteSource
} from '../mcp/tools/ports.js';
import type { LocalConfig } from './config.js';

/** The single local site id. Stable across runs so logs and proposals line up. */
export const LOCAL_SITE_ID = 'local';
export const LOCAL_USER_ID = 'local-user';

export function buildSiteRow(config: LocalConfig, capabilities?: SiteCapabilities, now = Date.now()): SiteRow {
  return {
    id: LOCAL_SITE_ID,
    user_id: LOCAL_USER_ID,
    label: config.label,
    base_url: config.baseUrl,
    edition: 'unknown',
    bludit_version: '',
    // Intentionally empty: nothing is encrypted or stored locally. The Bludit
    // client is built from configuration on each call.
    api_token_enc: '',
    auth_token_enc: '',
    wizard_api_key_enc: '',
    wizard_api_base: config.wizardApiKey === '' ? '' : config.wizardApiBase,
    capabilities_json: capabilities ? JSON.stringify(capabilities) : '{}',
    status: 'connected',
    last_error: '',
    created_at: now,
    updated_at: now,
    last_checked_at: capabilities ? capabilities.checkedAt : 0
  };
}

/**
 * One site, from configuration.
 *
 * The capability cache is in memory, so a probe is not repeated on every call
 * within a run and nothing is written to disk.
 */
export function configSiteSource(config: LocalConfig): SiteSource {
  let cachedCapabilities: SiteCapabilities | undefined;

  const client = (): BluditClient =>
    new BluditClient(
      {
        baseUrl: config.baseUrl,
        apiToken: config.apiToken,
        authToken: config.authToken,
        wizardApiKey: config.wizardApiKey,
        wizardApiBase: config.wizardApiBase
      },
      { policy: config.policy }
    );

  const resolved = (): ResolvedSite => {
    const row = buildSiteRow(config, cachedCapabilities);
    return { row, public: toPublicSite(row, true), client: client() };
  };

  return {
    async list(): Promise<SiteRow[]> {
      return [buildSiteRow(config, cachedCapabilities)];
    },

    async resolve(reference: string): Promise<ResolvedSite> {
      const wanted = reference.trim().toLowerCase();
      const host = new URL(config.baseUrl).hostname.toLowerCase();
      const matches =
        wanted === LOCAL_SITE_ID ||
        wanted === config.label.toLowerCase() ||
        wanted === host ||
        wanted === config.baseUrl.toLowerCase();

      if (!matches) {
        throw new ToolError('not_found', 'No connected site matched that reference.', {
          // The local edition has exactly one site, and naming it is more useful
          // than describing what went wrong.
          available: [{ id: LOCAL_SITE_ID, label: config.label, baseUrl: config.baseUrl }]
        });
      }
      return resolved();
    },

    async default(): Promise<ResolvedSite> {
      // Unambiguous: there is exactly one site, by construction. The `site`
      // argument on every tool therefore stays optional.
      return resolved();
    },

    async updateCapabilities(_siteId: string, capabilities: SiteCapabilities): Promise<void> {
      cachedCapabilities = capabilities;
    }
  };
}

/** Audit to stderr, redacted, and never able to fail a tool call. */
export function stderrAuditSink(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): AuditSink {
  return {
    async record(entry: AuditEntry): Promise<void> {
      try {
        write(
          JSON.stringify({
            level: 'info',
            event: 'audit',
            tool: entry.tool,
            outcome: entry.outcome,
            siteId: entry.siteId ?? LOCAL_SITE_ID,
            // A stable code, never a message, exactly as the hosted sink does.
            detail: entry.detail ?? ''
          })
        );
      } catch {
        // Auditing must never turn a working tool call into a failed one.
      }
    }
  };
}

interface Held extends ProposalRow {
  payload: Record<string, unknown>;
}

/**
 * In-memory proposals, with the hosted store's semantics: immutable on creation,
 * expiring, bound to one site, and pinned to a page revision.
 *
 * The only difference is durability, and it is stated in the tool description and
 * the setup guide: a proposal does not survive a restart, because there is no
 * database to put it in.
 */
export function memoryProposalStore(ttlSeconds: number, now: () => number = Date.now): ProposalStore {
  const held = new Map<string, Held>();
  let counter = 0;

  const sweep = (at: number): void => {
    for (const proposal of held.values()) {
      if (proposal.expires_at <= at && proposal.status === 'proposed') proposal.status = 'expired';
    }
  };

  return {
    async create(input: CreateProposalInput): Promise<{ id: string; expiresAt: number }> {
      const at = now();
      sweep(at);
      counter += 1;
      const id = `prop_local_${counter}`;
      const expiresAt = at + ttlSeconds * 1000;
      held.set(id, {
        id,
        user_id: LOCAL_USER_ID,
        site_id: input.siteId,
        page_key: input.pageKey,
        base_revision: input.baseRevision,
        operation: input.operation as ProposalOperation,
        payload_json: JSON.stringify(input.payload),
        payload_hash: await stableHashHex(input.payload),
        status: 'proposed',
        created_at: at,
        expires_at: expiresAt,
        applied_at: null,
        applied_by_client_id: '',
        payload: input.payload
      });
      return { id, expiresAt };
    },

    async get(siteId: string, proposalId: string): Promise<ProposalRow> {
      const at = now();
      sweep(at);
      const proposal = held.get(proposalId);
      // Same error whether it never existed, expired, or belongs to another site:
      // a caller must not be able to probe for proposals.
      if (!proposal || proposal.site_id !== siteId) {
        throw new ToolError('not_found', 'No matching proposal was found for this account and site.');
      }
      return proposal;
    },

    async claim(proposalId: string, clientId: string): Promise<boolean> {
      const proposal = held.get(proposalId);
      if (!proposal || proposal.status !== 'proposed') return false;
      proposal.status = 'applied';
      proposal.applied_at = now();
      proposal.applied_by_client_id = clientId;
      return true;
    },

    async release(proposalId: string): Promise<void> {
      const proposal = held.get(proposalId);
      if (proposal && proposal.status === 'applied') {
        proposal.status = 'proposed';
        proposal.applied_at = null;
      }
    },

    ttlSeconds: () => ttlSeconds
  };
}
