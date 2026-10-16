/**
 * OAuth 2.1 security properties.
 *
 * These tests assert the properties the design claims, not just happy paths:
 * per-client isolation, per-user isolation, scope enforcement on the server,
 * PKCE, code replay resistance, revocation, and refresh behaviour.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import {
  accessToken,
  authorize,
  callTool,
  createAccount,
  createPkce,
  discover,
  exchangeCode,
  registerClient,
  type Account,
  type ClientCredentials,
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

const READ_SCOPES = 'sites:read pages:read offline_access';

let harness: Harness;
let site: MockBludit;
let as: DiscoveredServer;
let accountA: Account;
let accountB: Account;
let clientA: ClientCredentials;
let clientB: ClientCredentials;
let clientC: ClientCredentials;
let siteIdA: string;

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'api-a',
    authToken: 'auth-a',
    siteTitle: 'Tenant A site',
    pages: [
      { title: 'About', description: 'About tenant A', content: '# About\n\nTenant A content.\n', tags: ['tenant-a'] }
    ]
  });
  harness = await startHarness();
  as = await discover(harness.mcp, harness.auth);
  accountA = await createAccount(harness.auth, 'owner-a@example.test');
  accountB = await createAccount(harness.auth, 'owner-b@example.test');
  clientA = await registerClient(harness.auth, as, 'http://127.0.0.1:7654/callback-a');
  clientB = await registerClient(harness.auth, as, 'http://127.0.0.1:7655/callback-b');
  clientC = await registerClient(harness.auth, as, 'http://127.0.0.1:7656/callback-c');

  const tokens = await accessToken(harness.auth, accountA, {
    as,
    client: clientA,
    scope: 'sites:read pages:read pages:write settings:read offline_access'
  });
  void tokens;

  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    accountA,
    { siteUrl: site.url, apiToken: 'api-a', authToken: 'auth-a', label: 'Tenant A' },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) throw new Error(`Connect failed: ${outcome.html.slice(0, 400)}`);
  siteIdA = outcome.siteId as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

describe('resource server authorization', () => {
  it('rejects a request with no token and advertises the baseline scopes', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE);
    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain('Bearer');
    expect(header).toContain('resource_metadata=');
    expect(header).toContain('scope="sites:read pages:read"');
  });

  it('challenges a write performed with a read-only token, naming every scope it needs', async () => {
    const readOnly = await accessToken(harness.auth, accountA, { as, client: clientA, scope: READ_SCOPES });
    expect(readOnly.scope.split(' ')).toContain('pages:read');
    expect(readOnly.scope).not.toContain('pages:write');

    const result = await callTool(harness.mcp, readOnly.access_token, 'create_page', {
      title: 'Should not exist',
      content: 'nope'
    });
    expect(result.status).toBe(403);
    expect(result.challenge).toContain('error="insufficient_scope"');
    // The challenge must name the baseline plus the missing write scope.
    expect(result.challenge).toContain('sites:read');
    expect(result.challenge).toContain('pages:read');
    expect(result.challenge).toContain('pages:write');
  });

  it('lets a read-only token use read tools', async () => {
    const readOnly = await accessToken(harness.auth, accountA, { as, client: clientA, scope: READ_SCOPES });
    const result = await callTool(harness.mcp, readOnly.access_token, 'list_pages', {});
    expect(result.status).toBe(200);
    expect(result.isError).toBe(false);
  });

  it('refuses a write scope without the baseline read scopes', async () => {
    const writeOnly = await accessToken(harness.auth, accountA, { as, client: clientA, scope: 'pages:write' });
    const result = await callTool(harness.mcp, writeOnly.access_token, 'create_page', {
      title: 'Nope',
      content: 'nope'
    });
    expect(result.status).toBe(403);
    expect(result.challenge).toContain('sites:read');
  });

  it('rejects a token minted for a different resource', async () => {
    // Ask for a resource the authorization server does not declare.
    const pkce = await createPkce();
    const response = await harness.auth.fetch(`${as.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code',
      client_id: clientA.clientId,
      redirect_uri: clientA.redirectUri,
      scope: READ_SCOPES,
      state: 'x',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: 'http://127.0.0.1:9999/other'
    })}`, { headers: { cookie: accountA.jar.header() }, redirect: 'manual' });
    // Either an error redirect or a 400; never a code for the wrong audience.
    const location = response.headers.get('location') ?? '';
    expect(`${response.status} ${location}`).not.toMatch(/[?&]code=/);
  });
});

describe('per-client isolation', () => {
  it('revoking one client does not affect another', async () => {
    const tokenA = await accessToken(harness.auth, accountA, { as, client: clientA, scope: READ_SCOPES });
    const tokenB = await accessToken(harness.auth, accountA, { as, client: clientB, scope: READ_SCOPES });

    // Both clients work.
    expect((await callTool(harness.mcp, tokenA.access_token, 'list_sites', {})).status).toBe(200);
    expect((await callTool(harness.mcp, tokenB.access_token, 'list_sites', {})).status).toBe(200);

    // Revoke client B's grant through the account's own UI.
    const clientsPage = await harness.auth.fetch(`${AUTH_ORIGIN}/clients`, {
      headers: { cookie: accountA.jar.header() }
    });
    const html = await clientsPage.text();
    accountA.jar.absorb(clientsPage);
    const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
    const grantMatch = new RegExp(
      `<code>${escapeRegExp(clientB.clientId.slice(0, 60))}</code>[\\s\\S]*?action="/clients/([^/]+)/revoke"`
    ).exec(html);
    expect(grantMatch, 'client B grant should be listed').not.toBeNull();

    await harness.auth.fetch(`${AUTH_ORIGIN}/clients/${grantMatch?.[1]}/revoke`, {
      method: 'POST',
      headers: { cookie: accountA.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString()
    });

    // Client B is now rejected; client A is untouched.
    expect((await callTool(harness.mcp, tokenB.access_token, 'list_sites', {})).status).toBe(401);
    expect((await callTool(harness.mcp, tokenA.access_token, 'list_sites', {})).status).toBe(200);
  });
});

describe('per-account isolation', () => {
  it('shows account B no sites, and never account A\'s site', async () => {
    const tokenB = await accessToken(harness.auth, accountB, { as, client: clientB, scope: 'sites:read pages:read' });
    const list = await callTool(harness.mcp, tokenB.access_token, 'list_sites', {});
    expect(list.isError).toBe(false);
    expect((list.data as { count: number }).count).toBe(0);
  });

  it('refuses to act on another account\'s site even with a guessed id', async () => {
    const tokenB = await accessToken(harness.auth, accountB, {
      as,
      client: clientB,
      scope: 'sites:read pages:read pages:write'
    });
    const result = await callTool(harness.mcp, tokenB.access_token, 'list_pages', { site: siteIdA });
    expect(result.isError).toBe(true);
    const error = (result.data as { error: { code: string; details?: Record<string, unknown> } }).error;
    expect(error.code).toBe('not_found');
    // The error must not disclose that the site exists.
    expect(JSON.stringify(error)).not.toContain('Tenant A');
  });

  it('does not let account B apply account A\'s proposal', async () => {
    const ownerToken = await accessToken(harness.auth, accountA, {
      as,
      client: clientA,
      scope: 'sites:read pages:read pages:write'
    });
    const proposal = await callTool(harness.mcp, ownerToken.access_token, 'propose_page_edit', {
      site: siteIdA,
      key: 'about',
      operation: 'edit',
      description: 'owner edit'
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;

    const otherToken = await accessToken(harness.auth, accountB, {
      as,
      client: clientB,
      scope: 'sites:read pages:read pages:write'
    });
    const attempt = await callTool(harness.mcp, otherToken.access_token, 'apply_approved_edit', {
      site: siteIdA,
      proposal_id: proposalId,
      confirm: true
    });
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('authorization code flow hardening', () => {
  it('requires PKCE on the token exchange', async () => {
    const { code } = await authorize(harness.auth, accountA, { as, client: clientA, scope: READ_SCOPES });
    const response = await harness.auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: clientA.redirectUri,
        client_id: clientA.clientId,
        resource: MCP_RESOURCE
      }).toString()
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain('invalid_request');
  });

  it('rejects a replayed authorization code', async () => {
    const pair = await createPkce();
    const code = await issueCode(accountA, clientA, READ_SCOPES, pair.challenge, 'replay');
    const exchanged = await exchangeCode(harness.auth, as, clientA, code, pair.verifier);
    expect(exchanged.access_token).toBeTruthy();

    const replay = await harness.auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: clientA.redirectUri,
        client_id: clientA.clientId,
        code_verifier: pair.verifier,
        resource: MCP_RESOURCE
      }).toString()
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a token exchange with a mismatched redirect_uri', async () => {
    const pair = await createPkce();
    const code = await issueCode(accountA, clientA, READ_SCOPES, pair.challenge, 'mismatch');

    const response = await harness.auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:7654/other-path',
        client_id: clientA.clientId,
        code_verifier: pair.verifier,
        resource: MCP_RESOURCE
      }).toString()
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an unregistered redirect URI', async () => {
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientA.clientId,
      redirect_uri: 'http://127.0.0.1:9999/evil',
      scope: READ_SCOPES,
      state: 'evil',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const response = await harness.auth.fetch(url.toString(), {
      headers: { cookie: accountA.jar.header() },
      redirect: 'manual'
    });
    // No redirect to the attacker: the page is rendered locally.
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(400);
  });

  it('refuses an unknown client', async () => {
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: 'client-that-does-not-exist',
      redirect_uri: clientA.redirectUri,
      scope: READ_SCOPES,
      state: 'unknown',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const response = await harness.auth.fetch(url.toString(), {
      headers: { cookie: accountA.jar.header() },
      redirect: 'manual'
    });
    expect(response.status).toBe(400);
  });
});

describe('consent', () => {
  it('records a denial as access_denied and issues no token', async () => {
    const pkce = await createPkce();
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientC.clientId,
      redirect_uri: clientC.redirectUri,
      scope: READ_SCOPES,
      state: 'deny-me',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const consentPage = await harness.auth.fetch(url.toString(), { headers: { cookie: accountA.jar.header() } });
    accountA.jar.absorb(consentPage);
    const html = await consentPage.text();
    const decision = await harness.auth.fetch(`${AUTH_ORIGIN}/authorize/decision`, {
      method: 'POST',
      headers: { cookie: accountA.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf: /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string,
        handle: /name="handle" value="([^"]*)"/.exec(html)?.[1] as string,
        decision: 'deny'
      }).toString(),
      redirect: 'manual'
    });
    const location = decision.headers.get('location') as string;
    expect(location).toContain('error=access_denied');
    expect(location).toContain('state=deny-me');
    expect(location).not.toContain('code=');
  });

  it('shows the client name and the redirect host before allowing', async () => {
    const pkce = await createPkce();
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientC.clientId,
      redirect_uri: clientC.redirectUri,
      scope: 'sites:read pages:read pages:write',
      state: 'view',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const page = await harness.auth.fetch(url.toString(), { headers: { cookie: accountA.jar.header() } });
    const html = await page.text();
    expect(html).toContain('Integration test client');
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('pages:write');
    expect(html).toContain('local application');
  });

  it('requires a valid CSRF token on the consent decision', async () => {
    const pkce = await createPkce();
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientC.clientId,
      redirect_uri: clientC.redirectUri,
      scope: READ_SCOPES,
      state: 'csrf',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const consentPage = await harness.auth.fetch(url.toString(), {
      headers: { cookie: accountA.jar.header() },
      redirect: 'manual'
    });
    accountA.jar.absorb(consentPage);
    expect(consentPage.status).toBe(200);
    const handle = /name="handle" value="([^"]*)"/.exec(await consentPage.text())?.[1] as string;

    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/authorize/decision`, {
      method: 'POST',
      headers: { cookie: accountA.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'not-the-token', handle, decision: 'allow' }).toString(),
      redirect: 'manual'
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
  });
  it('honours a remembered decision without re-showing the page', async () => {
    const first = await accessToken(harness.auth, accountA, {
      as,
      client: clientC,
      scope: READ_SCOPES,
      remember: true
    });
    void first;

    // Same client, same scopes, no interaction this time.
    const pkce = await createPkce();
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientC.clientId,
      redirect_uri: clientC.redirectUri,
      scope: READ_SCOPES,
      state: 'remembered',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const response = await harness.auth.fetch(url.toString(), {
      headers: { cookie: accountA.jar.header() },
      redirect: 'manual'
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('code=');
  });

});

describe('refresh and expiry', () => {
  it('issues a refresh token and honours it', async () => {
    const tokens = await accessToken(harness.auth, accountA, { as, client: clientA, scope: READ_SCOPES });
    expect(tokens.refresh_token).toBeTruthy();

    const refreshed = await harness.auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: clientA.clientId,
        resource: 'http://127.0.0.1:8788/mcp'
      }).toString()
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { access_token: string };
    expect((await callTool(harness.mcp, body.access_token, 'list_sites', {})).status).toBe(200);
  });
});

describe('client identification via metadata document (CIMD)', () => {
  let docServer: Server;
  let metadataUrl: string;

  beforeAll(async () => {
    docServer = createServer((req, res) => {
      const base = `http://127.0.0.1:${(docServer.address() as AddressInfo).port}`;
      if (req.url?.startsWith('/client-metadata.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: `${base}/client-metadata.json`,
            client_name: 'CIMD test client',
            redirect_uris: ['http://127.0.0.1:7666/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            response_types: ['code']
          })
        );
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => docServer.listen(0, '127.0.0.1', resolve));
    metadataUrl = `http://127.0.0.1:${(docServer.address() as AddressInfo).port}/client-metadata.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => docServer.close(() => resolve()));
  });

  it('rejects a metadata document URL that does not resolve', async () => {
    const url = new URL(as.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: 'http://127.0.0.1:1/missing.json',
      redirect_uri: 'http://127.0.0.1:7666/callback',
      scope: READ_SCOPES,
      state: 'cimd-missing',
      resource: 'http://127.0.0.1:8788/mcp'
    })) {
      url.searchParams.set(key, value);
    }
    const response = await harness.auth.fetch(url.toString(), {
      headers: { cookie: accountA.jar.header() },
      redirect: 'manual'
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('location')).toBeNull();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drive /authorize → consent → decision and return the authorization code.
 * Kept local to this file because several tests need the code without
 * exchanging it immediately.
 */
async function issueCode(
  account: Account,
  client: ClientCredentials,
  scope: string,
  codeChallenge: string,
  state: string,
  decision: 'allow' | 'deny' = 'allow'
): Promise<string> {
  const url = new URL(as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: MCP_RESOURCE
  })) {
    url.searchParams.set(key, value);
  }

  const consentPage = await harness.auth.fetch(url.toString(), { headers: { cookie: account.jar.header() } });
  account.jar.absorb(consentPage);
  const html = await consentPage.text();
  const form = new URLSearchParams({
    csrf: /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string,
    handle: /name="handle" value="([^"]*)"/.exec(html)?.[1] as string,
    decision
  });
  if (decision === 'allow') {
    const requested = [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))];
    for (const requestedScope of requested) form.append('scope', requestedScope);
  }

  const response = await harness.auth.fetch(`${AUTH_ORIGIN}/authorize/decision`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual'
  });
  const location = response.headers.get('location') ?? '';
  const code = new URL(location, client.redirectUri).searchParams.get('code');
  if (!code) throw new Error(`Expected an authorization code, got: ${location || response.status}`);
  return code;
}
