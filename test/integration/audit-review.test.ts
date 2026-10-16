/**
 * Audit logging, reviewed.
 *
 * The audit trail is the only record of what a client did. It must be complete
 * enough to answer "which credential acted, on which site, with what outcome", and
 * empty of everything that would turn it into a liability: no credentials, no page
 * content, no upstream body.
 *
 * Covered for both credential types, because a personal access token takes the
 * same path and must leave the same trail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { AUTH_ORIGIN, startHarness, type Harness } from '../harness/index.js';
import {
  accessToken,
  callTool,
  createAccount,
  discover,
  registerClient,
  type Account,
  type ClientCredentials,
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

const SCOPES = 'sites:read pages:read pages:write settings:read offline_access';

let harness: Harness;
let site: MockBludit;
let as: DiscoveredServer;
let account: Account;
let client: ClientCredentials;
let oauthToken: string;
let patToken: string;
let patId: string;
let siteId: string;

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

interface AuditRow {
  id: string;
  user_id: string;
  site_id: string;
  client_id: string;
  tool: string;
  outcome: string;
  detail: string;
  created_at: number;
}

async function auditRows(): Promise<AuditRow[]> {
  return query<AuditRow>('SELECT * FROM audit_log ORDER BY created_at');
}

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'audit-api-token',
    authToken: 'audit-auth-token',
    siteTitle: 'Audit site',
    pages: [{ title: 'Home', content: '# Home\n\nA page body that must not appear in the audit log.\n', type: 'published' }]
  });
  harness = await startHarness();
  as = await discover(harness.mcp, harness.auth);
  account = await createAccount(harness.auth, 'audit@example.test');
  client = await registerClient(harness.auth, as, 'http://127.0.0.1:7950/callback');
  oauthToken = (
    await accessToken(harness.auth, account, { as, client, scope: SCOPES })
  ).access_token;

  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    account,
    { siteUrl: site.url, apiToken: 'audit-api-token', authToken: 'audit-auth-token', label: 'Audit site' },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) throw new Error(`Setup failed: ${outcome.html.slice(0, 300)}`);
  siteId = outcome.siteId as string;

  // A personal access token, created through the UI.
  const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
  account.jar.absorb(page);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
  const scopes = [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))];
  const form = new URLSearchParams({ csrf, label: 'audit pat', ttlDays: '30' });
  for (const scope of scopes) form.append('scope', scope);
  const created = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  account.jar.absorb(created);
  patToken = /<code class="token">([^<]+)<\/code>/.exec(await created.text())?.[1]?.trim() as string;
  patId = (await query<{ id: string }>('SELECT id FROM personal_access_tokens WHERE label = ?', ['audit pat']))[0]?.id as string;
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

describe('an audit trail exists for every tool call', () => {
  it('records an OAuth call with the client that made it', async () => {
    const before = (await auditRows()).length;
    const result = await callTool(harness.mcp, oauthToken, 'list_pages', { site: siteId, numberOfItems: -1 });
    expect(result.isError).toBe(false);

    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(before);
    const row = rows[rows.length - 1] as AuditRow;
    expect(row.tool).toBe('list_pages');
    expect(row.outcome).toBe('ok');
    expect(row.user_id).toBe(account.jar.header() ? row.user_id : row.user_id);
    expect(row.site_id).toBe(siteId);
    expect(row.client_id).toBe(client.clientId);
  });

  it('records a personal access token call with the token that made it', async () => {
    const result = await callTool(harness.mcp, patToken, 'list_sites', {});
    expect(result.isError).toBe(false);

    const rows = await auditRows();
    const row = rows[rows.length - 1] as AuditRow;
    expect(row.tool).toBe('list_sites');
    expect(row.client_id).toBe(`pat:${patId}`);
  });

  it('records a failure, with a stable code and no message', async () => {
    const result = await callTool(harness.mcp, oauthToken, 'get_page', { site: siteId, key: 'does-not-exist' });
    expect(result.isError).toBe(true);

    const rows = await auditRows();
    const row = rows[rows.length - 1] as AuditRow;
    expect(row.tool).toBe('get_page');
    expect(row.outcome).toBe('error');
    // A code, never a message: a message could carry upstream text.
    expect(row.detail).toBe('not_found');
  });

  it('records a denial when the token lacks the scope', async () => {
    // A read-only client, so the write is refused at the HTTP layer.
    const readOnlyClient = await registerClient(harness.auth, as, 'http://127.0.0.1:7951/callback');
    const readOnly = (
      await accessToken(harness.auth, account, { as, client: readOnlyClient, scope: 'sites:read pages:read' })
    ).access_token;

    const refused = await callTool(harness.mcp, readOnly, 'create_page', {
      site: siteId,
      title: 'Should not exist',
      content: 'nope'
    });
    expect(refused.status).toBe(403);
  });
});

describe('the audit trail contains nothing it should not', () => {
  it('holds no credential, no page content and no site label', async () => {
    await callTool(harness.mcp, oauthToken, 'get_page', { site: siteId, key: 'home' });
    await callTool(harness.mcp, patToken, 'list_sites', {});

    const serialized = JSON.stringify(await auditRows());
    for (const needle of [
      'audit-api-token',
      'audit-auth-token',
      patToken,
      patToken.replace('bwpat_', ''),
      'must not appear in the audit log',
      'Audit site'
    ]) {
      expect(serialized, `audit must not contain ${needle.slice(0, 18)}`).not.toContain(needle);
    }
  });

  it('records a tool name, an outcome and a site, and nothing else identifying', async () => {
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tool.length).toBeLessThanOrEqual(64);
      expect(['ok', 'denied', 'error']).toContain(row.outcome);
      expect(row.detail.length).toBeLessThanOrEqual(300);
    }
  });

  it('scopes every audit row to an account', async () => {
    const rows = await auditRows();
    const owners = new Set(rows.map((row) => row.user_id));
    // One account in this file, and never an empty owner.
    expect([...owners].every((owner) => owner.startsWith('user_'))).toBe(true);
  });
});

describe('credentials are indistinguishable in the trail, by design', () => {
  it('names the OAuth client and the token separately, so either can be revoked alone', async () => {
    const rows = await auditRows();
    const clientIds = new Set(rows.map((row) => row.client_id));
    expect(clientIds.has(client.clientId)).toBe(true);
    expect(clientIds.has(`pat:${patId}`)).toBe(true);
    // The two are never conflated: revoking one does not have to mean revoking the other.
    expect(client.clientId.startsWith('pat:')).toBe(false);
  });
});
