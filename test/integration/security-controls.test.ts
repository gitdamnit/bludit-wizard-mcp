/**
 * Security-control confirmations.
 *
 * The four controls a reviewer will ask about, each asserted under the profile
 * where it actually protects something:
 *
 *   1. Credential encryption at rest
 *   2. Grant revocation
 *   3. Cross-account isolation
 *   4. SSRF defence, including a direct probe of the platform layer
 *
 * Some of these properties are also asserted inside the suites that exercise the
 * feature they belong to. They are repeated here deliberately: a security review
 * should be able to read one file and see the four claims together, rather than
 * reconstructing each from a feature test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import {
  accessToken,
  callTool,
  createAccount,
  discover,
  listTools,
  registerClient,
  type Account,
  type ClientCredentials,
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile, requestChallenge, submitSite } from '../harness/site.js';

const ALL_SCOPES = 'sites:read pages:read pages:write settings:read offline_access';

let harness: Harness;
let site: MockBludit;
let as: DiscoveredServer;
let accountA: Account;
let accountB: Account;
let clientA: ClientCredentials;
let clientB: ClientCredentials;
let siteIdA: string;

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

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'the-api-token-value',
    authToken: 'the-auth-token-value',
    siteTitle: 'Security controls site',
    pages: [{ title: 'Home', content: '# Home\n\nBody.\n', type: 'published' }]
  });

  harness = await startHarness();
  as = await discover(harness.mcp, harness.auth);
  accountA = await createAccount(harness.auth, 'control-owner@example.test');
  accountB = await createAccount(harness.auth, 'control-other@example.test');
  clientA = await registerClient(harness.auth, as, 'http://127.0.0.1:7711/callback-a');
  clientB = await registerClient(harness.auth, as, 'http://127.0.0.1:7712/callback-b');

  site.setChallenge('');
  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    accountA,
    {
      siteUrl: site.url,
      apiToken: 'the-api-token-value',
      authToken: 'the-auth-token-value',
      label: 'Owned by A'
    },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) throw new Error(`Setup failed to connect the site: ${outcome.html.slice(0, 400)}`);
  siteIdA = outcome.siteId as string;
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

// ---------------------------------------------------------------------------
// 1. Credential encryption at rest
// ---------------------------------------------------------------------------

describe('credential encryption at rest', () => {
  it('stores ciphertext, not the credential', async () => {
    const rows = await query<{ api_token_enc: string; auth_token_enc: string; wizard_api_key_enc: string }>(
      'SELECT api_token_enc, auth_token_enc, wizard_api_key_enc FROM sites WHERE id = ?',
      [siteIdA]
    );
    const row = rows[0];
    expect(row?.api_token_enc).toMatch(/^v1\./);
    expect(row?.api_token_enc).not.toContain('the-api-token-value');
    expect(row?.auth_token_enc).not.toContain('the-auth-token-value');
    expect(JSON.stringify(row)).not.toContain('token-value');
  });

  it('never returns a credential from any read tool', async () => {
    const tokens = await accessToken(harness.auth, accountA, { as, client: clientA, scope: ALL_SCOPES });

    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_sites', { include_capabilities: true }],
      ['select_site', { site: siteIdA }],
      ['get_site_capabilities', { site: siteIdA, refresh: true }],
      ['get_website_settings', { site: siteIdA }],
      ['list_pages', { site: siteIdA, numberOfItems: -1 }],
      ['get_page', { site: siteIdA, key: 'home' }],
      ['list_tags', { site: siteIdA }],
      ['list_categories', { site: siteIdA }],
      ['get_drafts', { site: siteIdA }],
      ['get_scheduled_pages', { site: siteIdA }],
      ['search_pages', { site: siteIdA, query: 'home' }],
      ['get_content_summary', { site: siteIdA, key: 'home' }],
      ['get_related_pages', { site: siteIdA, key: 'home' }],
      ['preview_page_changes', { site: siteIdA, key: 'home', title: 'Changed' }]
    ];

    for (const [tool, args] of calls) {
      const result = await callTool(harness.mcp, tokens.access_token, tool, args);
      expect(result.raw, `${tool} output must not contain an API token`).not.toContain('the-api-token-value');
      expect(result.raw, `${tool} output must not contain an auth token`).not.toContain('the-auth-token-value');
      expect(result.raw, `${tool} output must not expose a ciphertext column`).not.toContain('_enc');
      expect(result.raw, `${tool} output must not expose envelope internals`).not.toMatch(/v1\.[A-Za-z0-9_-]{10,}\./);
    }
  });

  it('uses a fresh initialisation vector, so identical credentials do not produce identical ciphertext', async () => {
    // A second site with the same credentials must not produce the same bytes.
    const second = await startMockBludit({
      apiToken: 'the-api-token-value',
      authToken: 'the-auth-token-value',
      siteTitle: 'Same credentials, different site'
    });
    try {
      const account = await createAccount(harness.auth, 'control-iv@example.test');
      const outcome = await connectSiteWithWellKnownFile(
        harness.auth,
        account,
        { siteUrl: second.url, apiToken: 'the-api-token-value', authToken: 'the-auth-token-value', label: 'IV check' },
        (challenge) => second.setChallenge(challenge)
      );
      expect(outcome.ok, outcome.html.slice(0, 300)).toBe(true);

      const [a] = await query<{ api_token_enc: string }>('SELECT api_token_enc FROM sites WHERE id = ?', [siteIdA]);
      const [b] = await query<{ api_token_enc: string }>('SELECT api_token_enc FROM sites WHERE id = ?', [
        outcome.siteId
      ]);
      // Different site id as additional data AND a different IV: never equal.
      expect(a?.api_token_enc).not.toBe(b?.api_token_enc);
    } finally {
      await second.close();
    }
  });

  it('proves decryption works, because the live site accepted the decrypted token', async () => {
    // The mock rejects a wrong API token with 401, and capability probing only
    // reports readOk when the site answered.
    const tokens = await accessToken(harness.auth, accountA, { as, client: clientA, scope: ALL_SCOPES });
    const result = await callTool(harness.mcp, tokens.access_token, 'get_site_capabilities', {
      site: siteIdA,
      refresh: true
    });
    const capabilities = (result.data as { capabilities: { bluditApi: { readOk: boolean } } }).capabilities;
    expect(capabilities.bluditApi.readOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Grant revocation
// ---------------------------------------------------------------------------

describe('grant revocation', () => {
  it('stops the revoked client immediately and leaves other clients alone', async () => {
    const tokenA = await accessToken(harness.auth, accountA, { as, client: clientA, scope: 'sites:read pages:read' });
    const tokenB = await accessToken(harness.auth, accountA, { as, client: clientB, scope: 'sites:read pages:read' });
    expect((await callTool(harness.mcp, tokenA.access_token, 'list_sites', {})).status).toBe(200);
    expect((await callTool(harness.mcp, tokenB.access_token, 'list_sites', {})).status).toBe(200);

    // Revoke client B through the account's own UI.
    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/clients`, { headers: { cookie: accountA.jar.header() } });
    const html = await page.text();
    accountA.jar.absorb(page);
    const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
    const grantId = new RegExp(
      `${escapeRegExp(clientB.clientId.slice(0, 60))}[\\s\\S]*?action="/clients/([^/]+)/revoke"`
    ).exec(html)?.[1];
    expect(grantId, 'client B should be listed before revocation').toBeTruthy();

    const revoked = await harness.auth.fetch(`${AUTH_ORIGIN}/clients/${grantId}/revoke`, {
      method: 'POST',
      headers: { cookie: accountA.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
      redirect: 'manual'
    });
    expect(revoked.status).toBe(303);

    // B is refused; A is untouched.
    expect((await callTool(harness.mcp, tokenB.access_token, 'list_sites', {})).status).toBe(401);
    expect((await callTool(harness.mcp, tokenA.access_token, 'list_sites', {})).status).toBe(200);
  });

  it('refuses a refresh after revocation', async () => {
    const doomed = await accessToken(harness.auth, accountA, { as, client: clientB, scope: 'sites:read pages:read' });
    expect(doomed.refresh_token).toBeTruthy();

    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/clients`, { headers: { cookie: accountA.jar.header() } });
    const html = await page.text();
    accountA.jar.absorb(page);
    const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
    const grantId = new RegExp(
      `${escapeRegExp(clientB.clientId.slice(0, 60))}[\\s\\S]*?action="/clients/([^/]+)/revoke"`
    ).exec(html)?.[1];
    await harness.auth.fetch(`${AUTH_ORIGIN}/clients/${grantId}/revoke`, {
      method: 'POST',
      headers: { cookie: accountA.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
      redirect: 'manual'
    });

    const refreshed = await harness.auth.fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: doomed.refresh_token as string,
        client_id: clientB.clientId,
        resource: MCP_RESOURCE
      }).toString()
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
  });

  it('offers revocation per client, so authorizing one client does not authorize another', async () => {
    const page = await harness.auth.fetch(`${AUTH_ORIGIN}/clients`, { headers: { cookie: accountA.jar.header() } });
    const html = await page.text();
    accountA.jar.absorb(page);
    // Client A's grant must still be listed after B's was revoked.
    expect(html).toContain(escapeRegExp(clientA.clientId.slice(0, 60)).replace(/\\/g, ''));
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-account isolation
// ---------------------------------------------------------------------------

describe('cross-account isolation', () => {
  it('shows another account nothing about a site it does not own', async () => {
    const tokenB = await accessToken(harness.auth, accountB, {
      as,
      client: clientB,
      scope: 'sites:read pages:read pages:write settings:read'
    });

    const list = await callTool(harness.mcp, tokenB.access_token, 'list_sites', { include_capabilities: true });
    expect((list.data as { count: number }).count).toBe(0);

    const probes: Array<[string, Record<string, unknown>]> = [
      ['select_site', { site: siteIdA }],
      ['get_site_capabilities', { site: siteIdA, refresh: true }],
      ['list_pages', { site: siteIdA }],
      ['get_page', { site: siteIdA, key: 'home' }],
      ['get_website_settings', { site: siteIdA }],
      ['list_tags', { site: siteIdA }],
      ['list_categories', { site: siteIdA }],
      ['search_pages', { site: siteIdA, query: 'home' }],
      ['get_related_pages', { site: siteIdA, key: 'home' }],
      ['create_page', { site: siteIdA, title: 'Intruder', content: 'nope' }],
      ['edit_page', { site: siteIdA, key: 'home', title: 'Intruder' }],
      ['preview_page_changes', { site: siteIdA, key: 'home', title: 'Intruder' }]
    ];

    for (const [tool, args] of probes) {
      const result = await callTool(harness.mcp, tokenB.access_token, tool, args);
      expect(result.isError, `${tool} should have refused`).toBe(true);
      const error = (result.data as { error: { code: string } }).error;
      // `not_found`, never `forbidden`: the API must not confirm the site exists.
      expect(error.code, `${tool}`).toBe('not_found');
      // And it must not leak anything about it.
      expect(result.raw, `${tool}`).not.toContain('Owned by A');
      expect(result.raw, `${tool}`).not.toContain('Security controls site');
      expect(result.raw, `${tool}`).not.toContain(site.url);
    }

    // The site is untouched by the attempts.
    expect(site.pages.get('home')?.title).toBe('Home');
  });

  it('does not let another account apply a proposal it does not own', async () => {
    const tokenA = await accessToken(harness.auth, accountA, { as, client: clientA, scope: ALL_SCOPES });
    const proposal = await callTool(harness.mcp, tokenA.access_token, 'propose_page_edit', {
      site: siteIdA,
      key: 'home',
      operation: 'edit',
      title: 'Owner edit'
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    expect(proposalId).toBeTruthy();

    const tokenB = await accessToken(harness.auth, accountB, { as, client: clientB, scope: ALL_SCOPES });
    const attempt = await callTool(harness.mcp, tokenB.access_token, 'apply_approved_edit', {
      site: siteIdA,
      proposal_id: proposalId,
      confirm: true
    });
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: { code: string } }).error.code).toBe('not_found');

    // The proposal is still pending for its real owner.
    const applied = await callTool(harness.mcp, tokenA.access_token, 'apply_approved_edit', {
      site: siteIdA,
      proposal_id: proposalId,
      confirm: true
    });
    expect(applied.isError).toBe(false);
  });

  it('scopes every site row to its owner in the database', async () => {
    const rows = await query<{ id: string; user_id: string }>('SELECT id, user_id FROM sites');
    expect(rows.length).toBeGreaterThan(0);
    const owners = new Set(rows.map((row) => row.user_id));
    expect(owners.size).toBeGreaterThanOrEqual(1);
    // No site row may be readable by a second account: uniqueness is per owner.
    const duplicates = await query<{ base_url: string; user_id: string }>(
      'SELECT base_url, user_id FROM sites WHERE base_url = ?',
      [site.url]
    );
    for (const row of duplicates) {
      expect(rows.find((candidate) => candidate.id === siteIdA)?.user_id).toBe(row.user_id);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. SSRF defence
// ---------------------------------------------------------------------------

describe('SSRF defence under the production configuration', () => {
  /**
   * A third harness: the production compatibility flag **on**, and the
   * application-level loopback allowance **on**. That combination is what proves
   * the platform layer is doing real work — the application permits the request
   * and workerd refuses it anyway.
   */
  let hardened: Harness;

  beforeAll(async () => {
    hardened = await startHarness('production-shape', { auth: { ALLOW_INSECURE_SITE_URLS: 'true' } });
  }, 300_000);

  afterAll(async () => {
    await hardened?.close();
  });

  it('records that the platform egress restriction is NOT enforced by the local runtime', async () => {
    // This test documents a limitation rather than a defence, and it is here so
    // nobody concludes from a green suite that the platform layer was verified.
    //
    // With `global_fetch_strictly_public` set (as production configures) AND the
    // application-level loopback allowance switched on, a loopback fetch still
    // reaches the host under `wrangler`'s local runtime. Miniflare does not
    // enforce the private-address restriction, so an end-to-end probe of layer
    // one of the SSRF defence is impossible here.
    //
    // What that means in practice:
    //   * Layer one (the runtime) is verified by *configuration*, asserted in
    //     `test/unit/production-config.test.ts`, and by the post-deployment
    //     checks in `docs/DEPLOYMENT.md`.
    //   * Layers two to four (the URL policy, redirect revalidation, response
    //     bounds) are verified behaviourally, here and in `test/unit/ssrf.test.ts`.
    //   * The policy layer is therefore load-bearing, not belt-and-braces, and is
    //     tested accordingly.
    const account = await createAccount(hardened.auth, `ssrf-platform-${crypto.randomUUID()}@example.test`);
    const { challenge } = await requestChallenge(hardened.auth, account, { label: 'Platform layer' });
    const outcome = await submitSite(hardened.auth, account, challenge, {
      siteUrl: site.url,
      apiToken: 'the-api-token-value',
      label: 'Platform layer'
    });

    expect(outcome.ok).toBe(false);
    // The request reached the host: the failure is about the wrong challenge,
    // not about being unable to connect. If a future runtime starts enforcing
    // the flag locally, this becomes "could not be fetched" and this test will
    // fail loudly, which is the intended signal to update the documentation.
    expect(errorText(outcome)).toContain('ownership file exists but does not contain this challenge');
  });

  it('refuses plain http for a public host, whatever the loopback allowance says', async () => {
    // The loopback refusal itself is asserted in production-shape.test.ts, which
    // runs with insecure URLs disabled. This harness enables the loopback
    // allowance on purpose, so it checks the scheme rule instead.
    const account = await createAccount(hardened.auth, `ssrf-scheme-http-${crypto.randomUUID()}@example.test`);
    const { challenge } = await requestChallenge(hardened.auth, account, { label: 'Public http' });
    const outcome = await submitSite(hardened.auth, account, challenge, {
      siteUrl: 'http://blog.example.com',
      apiToken: 'x',
      label: 'Public http'
    });
    expect(outcome.ok).toBe(false);
    expect(errorText(outcome)).toContain('must use https');
  });

  it('refuses reserved, internal and credential-bearing URLs', async () => {
    const cases: Array<[string, string]> = [
      ['https://169.254.169.254/latest/meta-data/', 'private or reserved address'],
      ['http://169.254.169.254/', 'private or reserved address'],
      ['https://metadata.google.internal/', 'internal hostname'],
      ['https://[::ffff:169.254.169.254]/', 'private or reserved address'],
      ['https://[64:ff9b::169.254.169.254]/', 'private or reserved address'],
      ['https://[2002:a9fe:a9fe::1]/', 'private or reserved address'],
      ['https://user:pass@example.com/', 'must not embed credentials'],
      ['https://10.0.0.5/', 'private or reserved address'],
      ['https://vault.internal/', 'internal hostname']
    ];

    for (const [url, expected] of cases) {
      const account = await createAccount(hardened.auth, `ssrf-${crypto.randomUUID()}@example.test`);
      const { challenge } = await requestChallenge(hardened.auth, account, { label: 'Refused' });
      const outcome = await submitSite(hardened.auth, account, challenge, {
        siteUrl: url,
        apiToken: 'x',
        label: 'Refused'
      });
      expect(outcome.ok, `${url} should have been refused`).toBe(false);
      expect(outcome.html, `${url}`).toContain(expected);
    }
  }, 300_000);

  it('refuses a URL that would be a valid site but for its scheme', async () => {
    for (const url of ['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com']) {
      const account = await createAccount(hardened.auth, `ssrf-scheme-${crypto.randomUUID()}@example.test`);
      const { challenge } = await requestChallenge(hardened.auth, account, { label: 'Scheme' });
      const outcome = await submitSite(hardened.auth, account, challenge, {
        siteUrl: url,
        apiToken: 'x',
        label: 'Scheme'
      });
      expect(outcome.ok, `${url}`).toBe(false);
    }
  });

  it('reports the tool catalogue without needing a site, so SSRF cannot block normal use', async () => {
    const account = await createAccount(hardened.auth, `ssrf-tools-${crypto.randomUUID()}@example.test`);
    const client = await registerClient(hardened.auth, as, `http://127.0.0.1:${7713 + Math.floor(Math.random() * 200)}/cb`);
    const tokens = await accessToken(hardened.auth, account, { as, client, scope: 'sites:read pages:read' });
    const tools = await listTools(hardened.mcp, tokens.access_token);
    expect(tools.length).toBe(19);
  });
});

/** The user-facing error and its details, for readable assertions. */
function errorText(outcome: { html: string }): string {
  const message = /<p class="error">([^<]*)<\/p>/.exec(outcome.html)?.[1] ?? '(no error text)';
  const details = /<pre class="muted"[^>]*>([\s\S]*?)<\/pre>/.exec(outcome.html)?.[1] ?? '';
  return `${message} ${details}`.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
