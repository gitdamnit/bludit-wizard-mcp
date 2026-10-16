import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWellKnownBody, verifyWizardProof } from '../../src/sites/pairing.js';
import { assertProposalApplicable } from '../../src/proposals/store.js';
import type { ProposalRow } from '../../src/proposals/store.js';
import { constantTimeEqual } from '../../src/shared/crypto.js';

describe('pairing proofs', () => {
  const key = 'wizard-key-under-test';
  const challenge = 'challenge-value-abc123';

  function proof(keyValue: string, message: string): string {
    return createHmac('sha256', keyValue).update(message).digest('base64url');
  }

  it('accepts the correct HMAC proof', async () => {
    expect(await verifyWizardProof(key, challenge, proof(key, challenge))).toBe(true);
  });

  it('rejects a proof for a different challenge', async () => {
    expect(await verifyWizardProof(key, challenge, proof(key, 'other-challenge'))).toBe(false);
  });

  it('rejects a proof made with a different key', async () => {
    expect(await verifyWizardProof(key, challenge, proof('some-other-key', challenge))).toBe(false);
  });

  it('rejects an empty key or proof rather than throwing', async () => {
    expect(await verifyWizardProof('', challenge, proof(key, challenge))).toBe(false);
    expect(await verifyWizardProof(key, challenge, '')).toBe(false);
  });

  it('tolerates surrounding whitespace in the submitted proof', async () => {
    expect(await verifyWizardProof(key, challenge, `  ${proof(key, challenge)}\n`)).toBe(true);
  });

  it('accepts the exact well-known body and tolerates a trailing newline', () => {
    expect(verifyWellKnownBody(challenge, challenge)).toBe(true);
    expect(verifyWellKnownBody(challenge, `${challenge}\n`)).toBe(true);
    expect(verifyWellKnownBody(challenge, '  challenge-value-abc123  ')).toBe(true);
  });

  it('rejects a well-known body with any other content', () => {
    expect(verifyWellKnownBody(challenge, `${challenge}extra`)).toBe(false);
    expect(verifyWellKnownBody(challenge, 'a different challenge')).toBe(false);
    expect(verifyWellKnownBody(challenge, '')).toBe(false);
  });

  it('uses a comparison that does not short-circuit on content', () => {
    // Sanity check on the primitive the proofs rely on.
    expect(constantTimeEqual('a'.repeat(43), 'a'.repeat(43))).toBe(true);
    expect(constantTimeEqual('a'.repeat(43), `${'a'.repeat(42)}b`)).toBe(false);
  });
});

describe('proposal applicability', () => {
  const now = 1_800_000_000_000;

  function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
    return {
      id: 'prop_1',
      user_id: 'user_1',
      site_id: 'site_1',
      page_key: 'about',
      base_revision: 'rev-a',
      operation: 'edit',
      payload_json: JSON.stringify({ title: 'New title' }),
      payload_hash: 'hash',
      status: 'proposed',
      created_at: now - 1000,
      expires_at: now + 60_000,
      applied_at: null,
      applied_by_client_id: '',
      ...overrides
    };
  }

  it('returns the payload when everything lines up', () => {
    const payload = assertProposalApplicable(row(), { currentRevision: 'rev-a', pageExists: true, now });
    expect(payload).toEqual({ title: 'New title' });
  });

  it('refuses an already applied proposal', () => {
    expect(() => assertProposalApplicable(row({ status: 'applied' }), { now })).toThrow(
      expect.objectContaining({ code: 'conflict' }) as never
    );
  });

  it('refuses a rejected proposal', () => {
    expect(() => assertProposalApplicable(row({ status: 'rejected' }), { now })).toThrow(
      expect.objectContaining({ code: 'conflict' }) as never
    );
  });

  it('refuses an expired proposal, whether by status or by clock', () => {
    expect(() => assertProposalApplicable(row({ status: 'expired' }), { now })).toThrow(
      expect.objectContaining({ code: 'proposal_expired' }) as never
    );
    expect(() => assertProposalApplicable(row({ expires_at: now - 1 }), { now })).toThrow(
      expect.objectContaining({ code: 'proposal_expired' }) as never
    );
  });

  it('refuses when the page changed underneath it', () => {
    try {
      assertProposalApplicable(row(), { currentRevision: 'rev-b', pageExists: true, now });
      throw new Error('should have thrown');
    } catch (error) {
      const toolError = error as { code: string; details: Record<string, unknown> };
      expect(toolError.code).toBe('revision_mismatch');
      expect(toolError.details.expectedRevision).toBe('rev-a');
      expect(toolError.details.currentRevision).toBe('rev-b');
    }
  });

  it('refuses an edit whose page has disappeared', () => {
    expect(() => assertProposalApplicable(row(), { pageExists: false, now })).toThrow(
      expect.objectContaining({ code: 'revision_mismatch' }) as never
    );
  });

  it('refuses a creation when the page now exists', () => {
    const create = row({ operation: 'create', base_revision: '' });
    expect(() => assertProposalApplicable(create, { pageExists: true, now })).toThrow(
      expect.objectContaining({ code: 'conflict' }) as never
    );
  });

  it('does not apply a revision check to a creation', () => {
    const create = row({ operation: 'create', base_revision: '' });
    expect(assertProposalApplicable(create, { pageExists: false, currentRevision: 'anything', now })).toEqual({
      title: 'New title'
    });
  });
});
