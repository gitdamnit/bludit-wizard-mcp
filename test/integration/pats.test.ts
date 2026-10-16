/**
 * Personal access tokens, end to end.
 *
 * This is the credential path for the target clients that cannot complete an OAuth
 * flow: GitHub Copilot's cloud agent and code review, Mistral's Vibe Code CLI, and
 * Empryo. Those clients send a fixed `Authorization` header, so if this does not
 * work they cannot connect at all.
 *
 * The tests below assert that a token is a *credential for the same system*, not a
 * way around it: same scope enforcement, same tenancy, same audit trail, same
 * refusal to delete.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import { callTool, createAccount, type Account } from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

let harness: Harness;
let site: MockBludit;
let account: Account;
let siteId: string;

/** Read a row straight out of the local D1, through the test-only Worker. */
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const response = await harness.server.getWorker('test-schema').fetch('http://schema.test/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  const body = (await response.json()) as { ok: boolean; results?: T[]; error?: string };
  if (!body.ok) throw new Error(`query failed: ${body.error}`);
  return body.results ?? [];
}

/** Create a token through the real UI, returning the one-time plaintext. */
async function createToken(
  subject: Account,
  label: string,
  scopes: string[],
  ttlDays = 90
): Promise<{ token: string; id: string }> {
  const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: subject.jar.header() } });
  subject.jar.absorb(page);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;

  const form = new URLSearchParams({ csrf, label, ttlDays: String(ttlDays) });
  // The form renders every scope checked; sending a subset narrows it.
  const allScopes = [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))];
  for (const scope of allScopes) {
    if (scopes.includes(scope)) form.append('scope', scope);
  }

  const response = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
    method: 'POST',
    headers: { cookie: subject.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const body = await response.text();
  subject.jar.absorb(response);

  const token = /<code class="token">([^<]+)<\/code>/.exec(body)?.[1]?.trim();
  if (!token) throw new Error(`No token in the response: ${body.slice(0, 400)}`);
  const id = (await query<{ id: string }>('SELECT id FROM personal_access_tokens WHERE label = ?', [label]))[0]?.id as string;
  return { token, id };
}

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'pat-test-api-token',
    authToken: 'pat-test-auth-token',
    siteTitle: 'PAT test site',
    pages: [{ title: 'Home', content: '# Home\n\nBody.\n', type: 'published' }]
  });
  harness = await startHarness();
  account = await createAccount(harness.auth, 'pat-owner@example.test');

  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    account,
    { siteUrl: site.url, apiToken: 'pat-test-api-token', authToken: 'pat-test-auth-token', label: 'PAT site' },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) throw new Error(`Setup failed: ${outcome.html.slice(0, 300)}`);
  siteId = outcome.siteId as string;
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

describe('creation through the account UI', () => {
  it('shows the token exactly once and stores only a digest', async () => {
    const { token } = await createToken(account, 'shown once', ['sites:read', 'pages:read']);

    expect(token.startsWith('bwpat_')).toBe(true);

    const rows = await query<{ token_hash: string }>('SELECT token_hash FROM personal_access_tokens WHERE label = ?', [
      'shown once'
    ]);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).not.toContain(token.replace('bwpat_', ''));
  });

  it('does not show the token again on a later page load', async () => {
    const { token } = await createToken(account, 'not shown again', ['sites:read']);
    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
    const html = await page.text();
    account.jar.absorb(page);
    expect(html).not.toContain(token);
    expect(html).toContain('not shown again');
  });

  it('requires a signed-in account', async () => {
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/signin');
  });

  it('requires a CSRF token to create one', async () => {
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
      method: 'POST',
      headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'wrong', label: 'csrf', ttlDays: '30' }).toString()
    });
    expect(response.status).toBe(403);
  });

  it('refuses an empty label, because a token must be recognisable later', async () => {
    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
    account.jar.absorb(page);
    const csrf = /name="csrf" value="([^"]*)"/.exec(await page.text())?.[1] as string;
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
      method: 'POST',
      headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, label: '   ', ttlDays: '30' }).toString()
    });
    const html = await response.text();
    expect(html).toContain('A label is required');
  });
});

describe('use as a bearer credential', () => {
  it('authorises a tool call, and the audit trail names the token', async () => {
    const { token, id } = await createToken(account, 'bearer use', ['sites:read', 'pages:read']);

    const result = await callTool(harness.mcp, token, 'list_sites', {});
    expect(result.isError).toBe(false);
    expect((result.data as { count: number }).count).toBe(1);

    const audit = await query<{ client_id: string; tool: string }>(
      'SELECT client_id, tool FROM audit_log WHERE tool = ? ORDER BY created_at DESC',
      ['list_sites']
    );
    expect(audit[0]?.client_id).toBe(`pat:${id}`);
  });

  it('lets the client list, read and write a page', async () => {
    const { token } = await createToken(account, 'full flow', ['sites:read', 'pages:read', 'pages:write']);

    const list = await callTool(harness.mcp, token, 'list_pages', { site: siteId, numberOfItems: -1 });
    expect(list.isError).toBe(false);

    const created = await callTool(harness.mcp, token, 'create_page', {
      site: siteId,
      title: 'Created with a token',
      content: '# Created with a token\n',
      type: 'draft'
    });
    expect(created.isError).toBe(false);
    expect((created.data as { verified: boolean }).verified).toBe(true);

    const proposed = await callTool(harness.mcp, token, 'propose_page_edit', {
      site: siteId,
      key: (created.data as { key: string }).key,
      operation: 'edit',
      description: 'Reviewed change'
    });
    expect(proposed.isError).toBe(false);

    const applied = await callTool(harness.mcp, token, 'apply_approved_edit', {
      site: siteId,
      proposal_id: (proposed.data as { proposalId: string }).proposalId,
      confirm: true
    });
    expect(applied.isError).toBe(false);
  });

  it('enforces scopes exactly as an OAuth token does', async () => {
    const { token } = await createToken(account, 'read only', ['sites:read', 'pages:read']);

    // Reads work.
    expect((await callTool(harness.mcp, token, 'list_pages', { site: siteId })).status).toBe(200);

    // A write is refused with a step-up challenge naming the complete scope set.
    const refused = await callTool(harness.mcp, token, 'create_page', {
      site: siteId,
      title: 'Should not exist',
      content: 'nope'
    });
    expect(refused.status).toBe(403);
    expect(refused.challenge).toContain('pages:write');
    expect(refused.challenge).toContain('sites:read');
  });

  it('cannot see another account\'s site', async () => {
    const other = await createAccount(harness.auth, `pat-other-${crypto.randomUUID()}@example.test`);
    const { token } = await createToken(other, 'other account', ['sites:read', 'pages:read']);

    const list = await callTool(harness.mcp, token, 'list_sites', {});
    expect((list.data as { count: number }).count).toBe(0);

    const probe = await callTool(harness.mcp, token, 'list_pages', { site: siteId });
    expect(probe.isError).toBe(true);
    expect((probe.data as { error: { code: string } }).error.code).toBe('not_found');
    expect(probe.raw).not.toContain('PAT test site');
  });

  it('never exposes page deletion, whatever scopes it holds', async () => {
    const { token } = await createToken(account, 'cannot delete', ['sites:read', 'pages:read', 'pages:write']);
    const { body } = await (async () => {
      const response = await harness.mcp.fetch(MCP_RESOURCE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      });
      return { body: (await response.json()) as { result?: { tools?: Array<{ name: string }> } } };
    })();
    expect((body.result?.tools ?? []).map((tool) => tool.name)).not.toContain('delete_page');

    const attempt = await callTool(harness.mcp, token, 'delete_page', { site: siteId, key: 'home' });
    expect(attempt.isError).toBe(true);
  });
});

describe('revocation and expiry', () => {
  it('stops working the moment it is revoked', async () => {
    const { token, id } = await createToken(account, 'to revoke', ['sites:read', 'pages:read']);
    expect((await callTool(harness.mcp, token, 'list_sites', {})).status).toBe(200);

    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
    account.jar.absorb(page);
    const csrf = /name="csrf" value="([^"]*)"/.exec(await page.text())?.[1] as string;
    const revoked = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens/${id}/revoke`, {
      method: 'POST',
      headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
      redirect: 'manual'
    });
    expect(revoked.status).toBe(303);

    expect((await callTool(harness.mcp, token, 'list_sites', {})).status).toBe(401);
  });

  it('stops working once it expires, without waiting for a revocation', async () => {
    const { token, id } = await createToken(account, 'to expire', ['sites:read', 'pages:read']);
    expect((await callTool(harness.mcp, token, 'list_sites', {})).status).toBe(200);

    await harness.server
      .getWorker('test-schema')
      .fetch('http://schema.test/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: 'UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?', params: [1, id] })
      });

    expect((await callTool(harness.mcp, token, 'list_sites', {})).status).toBe(401);
  });

  it('rejects a token that was never issued', async () => {
    const result = await callTool(harness.mcp, 'bwpat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'list_sites', {});
    expect(result.status).toBe(401);
  });

  it('rejects a well-formed but truncated token', async () => {
    const { token } = await createToken(account, 'truncated', ['sites:read']);
    const result = await callTool(harness.mcp, token.slice(0, token.length - 4), 'list_sites', {});
    expect(result.status).toBe(401);
  });
});

describe('storage', () => {
  it('keeps no plaintext token anywhere in the database', async () => {
    const { token } = await createToken(account, 'storage check', ['sites:read', 'pages:read']);
    const rows = await query<Record<string, unknown>>('SELECT * FROM personal_access_tokens');
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(token.replace('bwpat_', ''));
    expect(serialized).toMatch(/[0-9a-f]{64}/);
  });

  it('records last use so a stale token is visible to its owner', async () => {
    const { token, id } = await createToken(account, 'last used', ['sites:read', 'pages:read']);
    expect((await query<{ last_used_at: number }>('SELECT last_used_at FROM personal_access_tokens WHERE id = ?', [id]))[0]?.last_used_at).toBe(0);

    await callTool(harness.mcp, token, 'list_sites', {});

    const after = await query<{ last_used_at: number }>(
      'SELECT last_used_at FROM personal_access_tokens WHERE id = ?',
      [id]
    );
    expect(Number(after[0]?.last_used_at)).toBeGreaterThan(0);
  });
});
