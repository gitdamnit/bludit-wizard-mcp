/**
 * The three ports that separate the portable core from a transport.
 *
 * The nineteen tools reach the outside world through exactly three
 * capabilities — "which site am I acting on", "where do proposals live", and
 * "where does the audit trail go" — and nothing else. Each transport supplies
 * its own implementation:
 *
 *   Cloudflare   D1 rows, scoped by the authenticated account
 *   Local stdio  one site read from configuration, in-memory proposals,
 *                audit on stderr
 *   Self-hosted  whatever the operator configures (design only)
 *
 * Everything the tools do beyond these ports is pure: the Bludit HTTP client, the
 * schemas, the validation, the diffing, the safety rules. That is what makes the
 * tool behaviour identical across transports, and it is why the extraction is
 * small rather than a rewrite.
 *
 * The interfaces deliberately describe **rows**, not domain objects, because the
 * tool bodies already read `resolved.row.id` and friends. Keeping that shape means
 * the extraction touches the ports and their call sites and leaves the tools
 * themselves alone.
 */

import type { BluditClient } from '../../bludit/client.js';
import type { SiteCapabilities } from '../../bludit/capability-types.js';
import type { ProposalOperation, ProposalRow } from '../../proposals/store.js';
import type { PublicSite, SiteRow } from '../../sites/registry-helpers.js';

/** A site resolved to a usable client: the row, the public view, the connection. */
export interface ResolvedSite {
  row: SiteRow;
  public: PublicSite;
  client: BluditClient;
}

/** Which site a tool acts on. */
export interface SiteSource {
  /** Every site this principal may act on, ordered by label. */
  list(): Promise<SiteRow[]>;

  /** Resolve a caller-supplied reference (id, label, or host) to exactly one site. */
  resolve(reference: string): Promise<ResolvedSite>;

  /**
   * The site to act on when the caller named none. Unambiguous with one site;
   * an error with several, because guessing is how a wrong-site write happens.
   */
  default(): Promise<ResolvedSite>;

  /** Record a refreshed capability probe. */
  updateCapabilities(siteId: string, capabilities: SiteCapabilities): Promise<void>;
}

export interface AuditEntry {
  tool: string;
  outcome: 'ok' | 'denied' | 'error';
  siteId?: string;
  detail?: string;
}

/**
 * Where the audit trail goes.
 *
 * An implementation must never throw in a way that fails the tool call: auditing
 * is a record of what happened, not a precondition for it.
 */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

export interface CreateProposalInput {
  siteId: string;
  pageKey: string;
  /** The live page revision, or `''` for a create. */
  baseRevision: string;
  operation: ProposalOperation;
  payload: Record<string, unknown>;
}

/**
 * Where review-before-write proposals live.
 *
 * The semantics are fixed by the core, not by a transport: a proposal is immutable
 * once created, expires, is bound to one site, and carries a revision pin. A
 * transport chooses only where they are stored.
 */
export interface ProposalStore {
  create(input: CreateProposalInput): Promise<{ id: string; expiresAt: number }>;

  /** Look up a proposal, scoped to this principal and site. Throws `not_found`. */
  get(siteId: string, proposalId: string): Promise<ProposalRow>;

  /**
   * Atomically move a proposal to applied. Returns false when another caller got
   * there first, so two concurrent applies cannot both write.
   */
  claim(proposalId: string, clientId: string): Promise<boolean>;

  /** Undo a claim after a failed write, so the proposal can be retried. */
  release(proposalId: string): Promise<void>;

  /** Lifetime applied to a newly created proposal. */
  ttlSeconds(): number;
}
