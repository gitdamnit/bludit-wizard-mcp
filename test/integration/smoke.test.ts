/**
 * Smoke test: both Workers boot in workerd, D1 migrations are applied, the
 * Service Binding resolves, and the OAuth discovery chain works end to end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import { createAccount, discover, registerClient } from '../harness/oauth-client.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('worker bootstrap', () => {
  it('serves the authorization server health check with a migrated database', async () => {
    const response = await harness.auth.fetch(`${AUTH_ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; db: string; issuer: string; resource: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
    expect(body.resource).toBe(MCP_RESOURCE);
  });

  it('challenges unauthenticated MCP requests with RFC 9728 metadata', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE);
    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain('resource_metadata=');
    expect(header).toContain('scope=');
  });

  it('completes discovery, registration and account creation', async () => {
    const as = await discover(harness.mcp, harness.auth);
    expect(as.issuer).toBe('http://127.0.0.1:8787');
    expect(as.scopes_supported).toContain('pages:write');
    expect(as.registration_endpoint).toBeTruthy();

    const client = await registerClient(harness.auth, as);
    expect(client.clientId).toBeTruthy();

    const account = await createAccount(harness.auth, 'smoke@example.test');
    expect(account.jar.header()).toContain('session');
  });
});
