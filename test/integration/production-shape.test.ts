/**
 * Production-shape configuration tests.
 *
 * These run with the same `global_fetch_strictly_public` compatibility flag the
 * deployed Workers use, and with `ALLOW_INSECURE_SITE_URLS=false`. That flag is
 * what the OAuth library requires before it will advertise Client ID Metadata
 * Document support, and what makes the runtime itself refuse private-address
 * egress — so it is worth asserting rather than assuming.
 *
 * The loopback mock Bludit server cannot be reached under this flag, which is
 * exactly why the CMS-tool tests use the `runtime` profile instead. That is a
 * real property of the production configuration, not a test workaround.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import { accessToken, createAccount, discover, listTools, registerClient } from '../harness/oauth-client.js';
import { requestChallenge, submitSite } from '../harness/site.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness('production-shape');
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

describe('production compatibility flags', () => {
  it('boots and serves a healthy authorization server', async () => {
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('advertises Client ID Metadata Document support once the flag is set', async () => {
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe('http://127.0.0.1:8787');
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.grant_types_supported).toContain('refresh_token');
  });

  it('publishes protected resource metadata at the URL named in the challenge', async () => {
    const challenge = await harness.mcp.fetch(MCP_RESOURCE);
    expect(challenge.status).toBe(401);
    const header = challenge.headers.get('www-authenticate') ?? '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    expect(metadataUrl).toBeTruthy();

    const response = await harness.mcp.fetch(metadataUrl as string);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(metadata.resource).toBe(MCP_RESOURCE);
    expect(metadata.authorization_servers).toEqual(['http://127.0.0.1:8787']);
  });

  it('still authorizes a client and lists tools end to end', async () => {
    const as = await discover(harness.mcp, harness.auth);
    const account = await createAccount(harness.auth, 'prodshape@example.test');
    const client = await registerClient(harness.auth, as, 'http://127.0.0.1:7677/callback');
    const tokens = await accessToken(harness.auth, account, { as, client, scope: 'sites:read pages:read' });
    const tools = await listTools(harness.mcp, tokens.access_token);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name)).toContain('list_sites');
  });

  it('refuses a loopback site URL, because insecure site URLs are disabled', async () => {
    const account = await createAccount(harness.auth, 'prodshape-ssrf@example.test');
    const { challenge } = await requestChallenge(harness.auth, account, { label: 'Loopback attempt' });
    const outcome = await submitSite(harness.auth, account, challenge, {
      siteUrl: 'http://127.0.0.1:9999',
      apiToken: 'whatever',
      label: 'Loopback attempt'
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.html).toContain('Loopback site URLs are only permitted in development mode');
  });

  it('refuses a cloud metadata address', async () => {
    const account = await createAccount(harness.auth, 'prodshape-meta@example.test');
    const { challenge } = await requestChallenge(harness.auth, account, { label: 'Metadata attempt' });
    const outcome = await submitSite(harness.auth, account, challenge, {
      siteUrl: 'https://169.254.169.254',
      apiToken: 'whatever',
      label: 'Metadata attempt'
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.html).toContain('private or reserved address');
  });

  it('refuses an internal hostname', async () => {
    const account = await createAccount(harness.auth, 'prodshape-internal@example.test');
    const { challenge } = await requestChallenge(harness.auth, account, { label: 'Internal attempt' });
    const outcome = await submitSite(harness.auth, account, challenge, {
      siteUrl: 'https://metadata.google.internal',
      apiToken: 'whatever',
      label: 'Internal attempt'
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.html).toContain('internal hostname');
  });
});
