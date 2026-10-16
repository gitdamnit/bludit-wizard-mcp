/**
 * Proposal store.
 *
 * A "proposal" is the only path to a write that an agent has not been granted
 * directly. It exists to defeat two specific failure modes:
 *
 *  - **Stale approvals.** A proposal pins the page revision it was built from.
 *    If the page changed in between, `apply_approved_edit` refuses instead of
 *    clobbering the newer edit.
 *  - **Cross-account application.** Every proposal is bound to a `user_id` and
 *    a `site_id`; lookup is scoped by both, so one account cannot apply
 *    another account's proposal even with a guessed id.
 *
 * Records are immutable apart from their status transition, and short-lived.
 */

import { ToolError } from '../shared/errors.js';
import { newId, stableHashHex } from '../shared/crypto.js';
import { DEFAULT_PROPOSAL_TTL_SECONDS, intVar, type SharedSecrets } from '../shared/env.js';

export type ProposalOperation = 'create' | 'edit';
export type ProposalStatus = 'proposed' | 'applied' | 'expired' | 'rejected';

export interface ProposalRow {
  id: string;
  user_id: string;
  site_id: string;
  page_key: string;
  base_revision: string;
  operation: ProposalOperation;
  payload_json: string;
  payload_hash: string;
  status: ProposalStatus;
  created_at: number;
  expires_at: number;
  applied_at: number | null;
  applied_by_client_id: string;
}

export function proposalTtlSeconds(env: SharedSecrets): number {
  return intVar(env.PROPOSAL_TTL_SECONDS, DEFAULT_PROPOSAL_TTL_SECONDS);
}

export interface CreateProposalInput {
  userId: string;
  siteId: string;
  pageKey: string;
  /** `''` for a create; the live page revision for an edit. */
  baseRevision: string;
  operation: ProposalOperation;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
  now?: number;
}

export interface CreatedProposal {
  id: string;
  expiresAt: number;
  payloadHash: string;
}

export async function createProposal(db: D1Database, input: CreateProposalInput): Promise<CreatedProposal> {
  const now = input.now ?? Date.now();
  const id = newId('prop');
  const payloadJson = JSON.stringify(input.payload);
  const payloadHash = await stableHashHex(input.payload);
  const expiresAt = now + (input.ttlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS) * 1000;

  await db
    .prepare(
      `INSERT INTO proposals (
         id, user_id, site_id, page_key, base_revision, operation,
         payload_json, payload_hash, status, created_at, expires_at, applied_at, applied_by_client_id
       ) VALUES (?,?,?,?,?,?,?,?, 'proposed', ?, ?, NULL, '')`
    )
    .bind(
      id,
      input.userId,
      input.siteId,
      input.pageKey,
      input.baseRevision,
      input.operation,
      payloadJson,
      payloadHash,
      now,
      expiresAt
    )
    .run();

  return { id, expiresAt, payloadHash };
}

export async function getProposal(
  db: D1Database,
  userId: string,
  siteId: string,
  proposalId: string
): Promise<ProposalRow> {
  const row = await db
    .prepare('SELECT * FROM proposals WHERE id = ? AND user_id = ? AND site_id = ?')
    .bind(proposalId, userId, siteId)
    .first<ProposalRow>();
  if (!row) {
    // Deliberately the same error whether the id is unknown or belongs to
    // another account: the store must not confirm the existence of others' rows.
    throw new ToolError('not_found', 'No matching proposal was found for this account and site.');
  }
  return row;
}

export interface ApplicabilityCheck {
  /** Current live revision of the page, when it still exists. */
  currentRevision?: string;
  /** Whether the page currently exists on the site. */
  pageExists?: boolean;
  now?: number;
}

/**
 * Enforce every precondition for applying a proposal. Throws `ToolError` with
 * an actionable code; returns the payload on success.
 */
export function assertProposalApplicable(
  proposal: ProposalRow,
  check: ApplicabilityCheck = {}
): Record<string, unknown> {
  const now = check.now ?? Date.now();

  if (proposal.status === 'applied') {
    throw new ToolError('conflict', 'This proposal has already been applied.', { proposalId: proposal.id });
  }
  if (proposal.status === 'rejected') {
    throw new ToolError('conflict', 'This proposal was rejected.', { proposalId: proposal.id });
  }
  if (proposal.status === 'expired' || proposal.expires_at <= now) {
    throw new ToolError('proposal_expired', 'This proposal has expired. Create a new one.', {
      proposalId: proposal.id,
      expiresAt: new Date(proposal.expires_at).toISOString()
    });
  }

  if (proposal.operation === 'edit') {
    if (check.pageExists === false) {
      throw new ToolError('revision_mismatch', 'The page no longer exists, so this edit cannot be applied.', {
        proposalId: proposal.id,
        pageKey: proposal.page_key
      });
    }
    if (check.currentRevision !== undefined && check.currentRevision !== proposal.base_revision) {
      throw new ToolError('revision_mismatch', 'The page changed after this proposal was created. Re-read it and propose again.', {
        proposalId: proposal.id,
        pageKey: proposal.page_key,
        expectedRevision: proposal.base_revision,
        currentRevision: check.currentRevision
      });
    }
  }

  if (proposal.operation === 'create' && check.pageExists === true) {
    throw new ToolError('conflict', 'A page with that key now exists, so this create cannot be applied.', {
      proposalId: proposal.id,
      pageKey: proposal.page_key
    });
  }

  return JSON.parse(proposal.payload_json) as Record<string, unknown>;
}

/** Atomic status transition. Returns false when another request got there first. */
export async function markProposalApplied(
  db: D1Database,
  proposalId: string,
  appliedByClientId: string,
  now = Date.now()
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE proposals SET status = 'applied', applied_at = ?, applied_by_client_id = ?
       WHERE id = ? AND status = 'proposed'`
    )
    .bind(now, appliedByClientId, proposalId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function rejectProposal(db: D1Database, userId: string, siteId: string, proposalId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE proposals SET status = 'rejected'
       WHERE id = ? AND user_id = ? AND site_id = ? AND status = 'proposed'`
    )
    .bind(proposalId, userId, siteId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function expireStaleProposals(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db
    .prepare(`UPDATE proposals SET status = 'expired' WHERE status = 'proposed' AND expires_at <= ?`)
    .bind(now)
    .run();
  return result.meta?.changes ?? 0;
}
