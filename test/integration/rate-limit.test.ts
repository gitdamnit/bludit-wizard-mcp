/**
 * Rate limiting, against the real Workers.
 *
 * Each bucket is driven over HTTP until it refuses, then checked for: the right
 * status, a usable `Retry-After`, isolation from other principals, a window that
 * actually resets, and no personal data anywhere in the counter table.
 *
 * Limits are injected as Worker vars, so the tight values under test are not the
 * values any other test file sees.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_ORIGIN, MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import {
  accessToken,
  callTool,
  createAccount,
  createPkce,
  discover,
  registerClient,
  type Account,
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile, requestChallenge, submitSite } from '../harness/site.js';
import { RATE_LIMIT_NAMES, rateLimitVarName } from '../../src/shared/rate-limit.js';
import { startMockBludit } from '../harness/mock-bludit.js';
import { mcpCall } from '../harness/oauth-client.js';
import type { AnyResponse } from '../harness/response.js';

/**
 * One request per bucket, with a one-request-per-window allowance where the test
 * only needs to see the refusal, and a short window where the test needs to see
 * it reset.
 */
/**
 * Values that keep the file's other tests unaffected by the buckets they are not
 * about. `RATE_LIMIT_ENABLED` is off in the Worker configs so no other suite
 * depends on production defaults; this file turns it on explicitly.
 */
const GENEROUS = {
  RATE_LIMIT_ENABLED: 'true',
  RL_SIGNUP: '1000/3600',
  RL_PAT_CREATE: '1000/3600',
  RL_CONSENT: '1000/3600',
  RL_SITE_CHECK: '1000/3600',
  RL_MCP_ACCOUNT: '100000/60'
} as const;

const TIGHT_LIMITS = {
  ...GENEROUS,
  RL_REGISTER: '2/3600',
  RL_SIGNIN: '2/900',
  RL_AUTHORIZE: '2/3600',
  RL_TOKEN: '2/3600',
  RL_PAIRING: '1/3600',
  RL_CONNECT: '1/3600',
  RL_MCP: '2/2'
} as const;

let harness: Harness;
let as: DiscoveredServer;
let account: Account;

/** Read rows straight out of the local D1, through the test-only Worker. */
async function queryRateLimits(): Promise<Array<{ bucket: string; count: number }>> {
  const response = await harness.server.getWorker('test-schema').fetch('http://schema.test/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT bucket, count FROM rate_limits' })
  });
  const body = (await response.json()) as { ok: boolean; results?: Array<{ bucket: string; count: number }> };
  return body.results ?? [];
}

async function registerFrom(ip: string, target: Harness = harness): Promise<AnyResponse> {
  return target.auth.fetch(`${AUTH_ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({
      redirect_uris: [`https://client.example/${crypto.randomUUID()}`],
      client_name: 'Rate limit probe',
      token_endpoint_auth_method: 'none'
    })
  });
}

async function signInAs(email: string, ip: string): Promise<AnyResponse> {
  return harness.auth.fetch(`${AUTH_ORIGIN}/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    body: new URLSearchParams({ email, password: 'not-the-right-password' }).toString(),
    redirect: 'manual'
  });
}

async function bootstrap(): Promise<void> {
  as = await discover(harness.mcp, harness.auth);
}

beforeAll(async () => {
  harness = await startHarness('runtime', { auth: { ...TIGHT_LIMITS }, mcp: { ...TIGHT_LIMITS } });
  await bootstrap();
  account = await createAccount(harness.auth, 'ratelimit@example.test');
}, 300_000);

afterAll(async () => {
  await harness?.close();
});

describe('account creation', () => {
  it('refuses a fourth signup from one address and allows a normal one', async () => {
    // Account creation is the most expensive unauthenticated endpoint: PBKDF2 plus
    // a row, reachable with no credential at all.
    const limited = await startHarness('runtime', { auth: { ...GENEROUS, RL_SIGNUP: '2/3600' } });
    try {
      const attempt = (n: number) =>
        limited.auth.fetch(`${AUTH_ORIGIN}/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.60' },
          body: new URLSearchParams({
            email: `signup-${n}-${Date.now()}@example.test`,
            password: 'a-sufficiently-long-password'
          }).toString(),
          redirect: 'manual'
        });

      expect((await attempt(1)).status).toBe(303);
      expect((await attempt(2)).status).toBe(303);
      const refused = await attempt(3);
      expect(refused.status).toBe(429);
      expect(await refused.text()).toContain('Too many accounts');
    } finally {
      await limited.close();
    }
  }, 300_000);

  it('does not lock out a different address', async () => {
    const limited = await startHarness('runtime', { auth: { ...GENEROUS, RL_SIGNUP: '1/3600' } });
    try {
      const signup = (ip: string) =>
        limited.auth.fetch(`${AUTH_ORIGIN}/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
          body: new URLSearchParams({
            email: `aside-${crypto.randomUUID()}@example.test`,
            password: 'a-sufficiently-long-password'
          }).toString(),
          redirect: 'manual'
        });
      expect((await signup('203.0.113.61')).status).toBe(303);
      expect((await signup('203.0.113.61')).status).toBe(429);
      expect((await signup('203.0.113.62')).status).toBe(303);
    } finally {
      await limited.close();
    }
  }, 300_000);
});

describe('personal access token management', () => {
  it('refuses a third token and still allows legitimate creation', async () => {
    const limited = await startHarness('runtime', { auth: { ...GENEROUS, RL_PAT_CREATE: '2/3600' } });
    try {
      const account = await createAccount(limited.auth, `pat-limit-${crypto.randomUUID()}@example.test`);
      const create = async (label: string) => {
        const page = await limited.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
        account.jar.absorb(page);
        const csrf = /name="csrf" value="([^"]*)"/.exec(await page.text())?.[1] as string;
        return limited.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
          method: 'POST',
          headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, label, ttlDays: '30', scope: 'sites:read' }).toString()
        });
      };

      expect((await create('first')).status).toBe(200);
      expect((await create('second')).status).toBe(200);
      const refused = await create('third');
      expect(refused.status).toBe(429);
      expect(await refused.text()).toContain('Too many tokens');
    } finally {
      await limited.close();
    }
  }, 300_000);

  it('never throttles revocation, because revoking a leaked token is a safety action', async () => {
    const limited = await startHarness('runtime', { auth: { ...GENEROUS, RL_PAT_CREATE: '1/3600' } });
    try {
      const account = await createAccount(limited.auth, `pat-revoke-${crypto.randomUUID()}@example.test`);
      const page = await limited.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
      account.jar.absorb(page);
      const html = await page.text();
      const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
      await limited.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
        method: 'POST',
        headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, label: 'revoke me', ttlDays: '30', scope: 'sites:read' }).toString()
      });

      const rows = await limited.server.getWorker('test-schema').fetch('http://schema.test/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT id FROM personal_access_tokens' })
      });
      const id = ((await rows.json()) as { results: Array<{ id: string }> }).results[0]?.id as string;

      // Ten revocations in a row must all be accepted, even with creation capped at 1.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await limited.auth.fetch(`${AUTH_ORIGIN}/tokens/${id}/revoke`, {
          method: 'POST',
          headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf }).toString(),
          redirect: 'manual'
        });
        expect(response.status, `revocation attempt ${attempt + 1}`).toBe(303);
      }
    } finally {
      await limited.close();
    }
  }, 300_000);
});

describe('client registration (DCR)', () => {
  it('refuses the third registration from one address, with OAuth-shaped errors', async () => {
    const ip = '203.0.113.10';

    const first = await registerFrom(ip);
    expect([200, 201]).toContain(first.status);
    const second = await registerFrom(ip);
    expect([200, 201]).toContain(second.status);

    const third = await registerFrom(ip);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    const body = (await third.json()) as { error: string; error_description: string };
    expect(body.error).toBe('temporarily_unavailable');
    expect(body.error_description).toContain('registration');
  });

  it('does not let one address exhaust the budget of another', async () => {
    const fresh = await registerFrom('203.0.113.11');
    expect([200, 201]).toContain(fresh.status);
  });
});

describe('sign-in', () => {
  it('refuses repeated attempts against one account', async () => {
    const email = `bruteforce-${crypto.randomUUID()}@example.test`;
    const ip = '203.0.113.20';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await signInAs(email, ip);
      expect(response.status).not.toBe(429);
    }

    const refused = await signInAs(email, ip);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
  });

  it('gives the same refusal whether or not the account exists', async () => {
    // Both accounts are already over their own limit-free budget? No: separate
    // buckets per email. The point is that the rate-limited answer is identical
    // for a real account and an invented one.
    const ip = '203.0.113.21';
    const real = 'ratelimit@example.test';
    const invented = `nobody-${crypto.randomUUID()}@example.test`;

    await signInAs(real, ip);
    await signInAs(real, ip);
    const realRefused = await signInAs(real, ip);

    await signInAs(invented, ip);
    await signInAs(invented, ip);
    const inventedRefused = await signInAs(invented, ip);

    expect(realRefused.status).toBe(429);
    expect(inventedRefused.status).toBe(429);
    const realBody = await realRefused.text();
    const inventedBody = await inventedRefused.text();
    // Only the identifiers differ inside the bucket; the response is byte-identical.
    expect(realBody).toBe(inventedBody);
  });

  it('does not lock out a different account from the same address', async () => {
    const other = `unrelated-${crypto.randomUUID()}@example.test`;
    const response = await signInAs(other, '203.0.113.20');
    expect(response.status).not.toBe(429);
  });
});

describe('authorization requests', () => {
  it('refuses once the per-address budget is spent', async () => {
    const ip = '203.0.113.30';
    const client = await registerClient(harness.auth, as, 'http://127.0.0.1:7691/callback');

    const build = async (): Promise<AnyResponse> => {
      const pkce = await createPkce();
      const url = new URL(as.authorization_endpoint);
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        scope: 'sites:read pages:read',
        state: 'rl',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        resource: MCP_RESOURCE
      })) {
        url.searchParams.set(key, value);
      }
      return harness.auth.fetch(url.toString(), {
        headers: { cookie: account.jar.header(), 'cf-connecting-ip': ip },
        redirect: 'manual'
      });
    };

    expect((await build()).status).not.toBe(429);
    expect((await build()).status).not.toBe(429);
    const refused = await build();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
  });
});

describe('token endpoint', () => {
  it('refuses once the per-address and per-client budget is spent', async () => {
    const ip = '203.0.113.40';
    const client = await registerClient(harness.auth, as, 'http://127.0.0.1:7692/callback');

    const attempt = async (): Promise<AnyResponse> =>
      harness.auth.fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'not-a-real-code',
          redirect_uri: client.redirectUri,
          client_id: client.clientId,
          code_verifier: 'not-a-real-verifier'
        }).toString()
      });

    // The first two fail on the code, not on the limit.
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).not.toBe(429);
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe('temporarily_unavailable');
  });
});

describe('site pairing and connection', () => {
  it('refuses a second pairing challenge from one account', async () => {
    const limitedAccount = await createAccount(harness.auth, `pairing-${crypto.randomUUID()}@example.test`);
    await requestChallenge(harness.auth, limitedAccount, { label: 'First' });

    await expect(requestChallenge(harness.auth, limitedAccount, { label: 'Second' })).rejects.toThrow(/429/);
  });

  it('refuses a second connection attempt from one account', async () => {
    const limitedAccount = await createAccount(harness.auth, `connect-${crypto.randomUUID()}@example.test`);
    const { challenge } = await requestChallenge(harness.auth, limitedAccount, { label: 'Once' });

    const first = await submitSite(harness.auth, limitedAccount, challenge, {
      siteUrl: 'https://unreachable.example.invalid',
      apiToken: 'x',
      label: 'Once'
    });
    expect(first.status).toBe(200);

    const second = await submitSite(harness.auth, limitedAccount, challenge, {
      siteUrl: 'https://unreachable.example.invalid',
      apiToken: 'x',
      label: 'Twice'
    });
    expect(second.status).toBe(429);
    expect(second.html).toContain('Too many connection attempts');
  });
});

describe('consent decisions and capability checks', () => {
  it('refuses a second consent decision, and a second capability check', async () => {
    const limited = await startHarness('runtime', {
      auth: { ...GENEROUS, RL_CONSENT: '1/3600', RL_SITE_CHECK: '1/3600' }
    });
    const mock = await startMockBludit({
      apiToken: 'rl-api',
      authToken: 'rl-auth',
      siteTitle: 'Rate limit site',
      pages: [{ title: 'Home', content: '# Home\n', type: 'published' }]
    });
    try {
      const as = await discover(limited.mcp, limited.auth);
      const account = await createAccount(limited.auth, `consent-limit-${crypto.randomUUID()}@example.test`);
      const client = await registerClient(limited.auth, as, 'http://127.0.0.1:7940/callback');

      // A capability check makes several outbound requests, so it is bounded per
      // account rather than left to hammer a customer's own site.
      const outcome = await connectSiteWithWellKnownFile(
        limited.auth,
        account,
        { siteUrl: mock.url, apiToken: 'rl-api', authToken: 'rl-auth', label: 'Rate limit site' },
        (challenge) => mock.setChallenge(challenge)
      );
      expect(outcome.ok, outcome.html.slice(0, 300)).toBe(true);

      const check = async () => {
        const page = await limited.auth.fetch(`${AUTH_ORIGIN}/sites`, { headers: { cookie: account.jar.header() } });
        account.jar.absorb(page);
        const csrf = /name="csrf" value="([^"]*)"/.exec(await page.text())?.[1] as string;
        return limited.auth.fetch(`${AUTH_ORIGIN}/sites/${outcome.siteId}/check`, {
          method: 'POST',
          headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf }).toString(),
          redirect: 'manual'
        });
      };
      expect((await check()).status).toBe(303);
      const checkRefused = await check();
      expect(checkRefused.status).toBe(429);
      expect(await checkRefused.text()).toContain('Too many capability checks');

      // One consent is allowed; the next is refused before the handle is even read.
      const consent = async () => {
        const pkce = await createPkce();
        const url = new URL(as.authorization_endpoint);
        for (const [key, value] of Object.entries({
          response_type: 'code',
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: 'sites:read pages:read',
          state: 'rl-consent',
          code_challenge: pkce.challenge,
          code_challenge_method: 'S256',
          resource: MCP_RESOURCE
        })) {
          url.searchParams.set(key, value);
        }
        const page = await limited.auth.fetch(url.toString(), {
          headers: { cookie: account.jar.header() },
          redirect: 'manual'
        });
        account.jar.absorb(page);
        const html = await page.text();
        const form = new URLSearchParams({
          csrf: /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string,
          handle: /name="handle" value="([^"]*)"/.exec(html)?.[1] as string,
          decision: 'allow'
        });
        for (const scope of [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))]) {
          form.append('scope', scope);
        }
        return limited.auth.fetch(`${AUTH_ORIGIN}/authorize/decision`, {
          method: 'POST',
          headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          redirect: 'manual'
        });
      };
      expect((await consent()).status).toBe(303);
      const consentRefused = await consent();
      expect(consentRefused.status).toBe(429);
      expect(await consentRefused.text()).toContain('Too many authorization decisions');
    } finally {
      await mock.close();
      await limited.close();
    }
  }, 300_000);
});

describe('MCP requests', () => {
  it('refuses once the per-account-and-client budget is spent, and resets after the window', async () => {
    const limited = await startHarness('runtime', { auth: { ...TIGHT_LIMITS }, mcp: { ...GENEROUS, RL_MCP: '1/2' } });
    try {
      const limitedAs = await discover(limited.mcp, limited.auth);
      const limitedAccount = await createAccount(limited.auth, `mcp-rl-${crypto.randomUUID()}@example.test`);
      const client = await registerClient(limited.auth, limitedAs, 'http://127.0.0.1:7693/callback');
      const tokens = await accessToken(limited.auth, limitedAccount, {
        as: limitedAs,
        client,
        scope: 'sites:read pages:read'
      });

      // The first request always fits, whatever the window boundary is doing.
      const first = await mcpCall(limited.mcp, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      expect(first.status).toBe(200);

      // Keep going until the limit bites, so this does not depend on where the
      // two-second boundary happens to fall.
      let refused: AnyResponse | undefined;
      for (let attempt = 0; attempt < 8 && refused === undefined; attempt += 1) {
        const response = await mcpCall(limited.mcp, tokens.access_token, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        });
        if (response.status === 429) refused = response.response;
      }
      expect(refused, 'the limit should refuse within a few window rolls').toBeDefined();
      expect(refused?.headers.get('retry-after')).toBeTruthy();
      expect(refused?.headers.get('x-ratelimit-remaining')).toBe('0');

      // Sleep until just past the reset instant the server reported.
      const resetSeconds = Number(refused?.headers.get('x-ratelimit-reset') ?? '0');
      const waitMs = Math.max(0, resetSeconds * 1000 - Date.now()) + 300;
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      const after = await mcpCall(limited.mcp, tokens.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {}
      });
      expect(after.status).toBe(200);
    } finally {
      await limited.close();
    }
  }, 300_000);

  it('bounds an account in aggregate, however many clients it has authorized', async () => {
    // Two clients, each with its own budget, but a low aggregate cap: the second
    // call from either client must fail. This is what protects a customer's CMS
    // from an account that authorized many clients.
    const limited = await startHarness('runtime', { auth: { ...GENEROUS }, mcp: { ...GENEROUS, RL_MCP_ACCOUNT: '1/300', RL_MCP: '100/300' } });
    try {
      const as = await discover(limited.mcp, limited.auth);
      const account = await createAccount(limited.auth, `mcp-agg-${crypto.randomUUID()}@example.test`);
      const client = await registerClient(limited.auth, as, 'http://127.0.0.1:7941/callback');
      const tokens = await accessToken(limited.auth, account, { as, client, scope: 'sites:read pages:read' });

      expect((await callTool(limited.mcp, tokens.access_token, 'list_sites', {})).status).toBe(200);

      // A 429 is an HTTP-level refusal, not a JSON-RPC error, so read the body.
      const refused = await mcpCall(limited.mcp, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });
      expect(refused.status).toBe(429);
      // `mcpCall` has already read the body, so read the parsed result it kept.
      const body = refused.body as unknown as { error: string; message: string };
      expect(body.error).toBe('rate_limited');
      expect(body.message).toContain('for this account');
    } finally {
      await limited.close();
    }
  }, 300_000);

  it('does not let one client exhaust the budget of another client on the same account', async () => {
    const other = await startHarness('runtime', { auth: { ...TIGHT_LIMITS }, mcp: { ...GENEROUS, RL_MCP: '1/300' } });
    try {
      const otherAs = await discover(other.mcp, other.auth);
      const otherAccount = await createAccount(other.auth, `mcp-iso-${crypto.randomUUID()}@example.test`);

      const clientOne = await registerClient(other.auth, otherAs, 'http://127.0.0.1:7694/callback-one');
      const clientTwo = await registerClient(other.auth, otherAs, 'http://127.0.0.1:7695/callback-two');
      const tokenOne = await accessToken(other.auth, otherAccount, {
        as: otherAs,
        client: clientOne,
        scope: 'sites:read pages:read'
      });
      const tokenTwo = await accessToken(other.auth, otherAccount, {
        as: otherAs,
        client: clientTwo,
        scope: 'sites:read pages:read'
      });

      expect((await callTool(other.mcp, tokenOne.access_token, 'list_sites', {})).status).toBe(200);
      // Client one is now out of budget for the window.
      expect((await callTool(other.mcp, tokenOne.access_token, 'list_sites', {})).status).toBe(429);
      // Client two is untouched: buckets are per client, not per account alone.
      expect((await callTool(other.mcp, tokenTwo.access_token, 'list_sites', {})).status).toBe(200);
    } finally {
      await other.close();
    }
  }, 300_000);
});

describe('storage and configuration', () => {
  it('stores no IP address and no email address', async () => {
    const rows = await queryRateLimits();
    expect(rows.length).toBeGreaterThan(0);
    // Every counter, including the ones added by the final security gate, so a
    // new bucket cannot be introduced with a key that leaks an identifier.
    const allowed = new RegExp(`^(${RATE_LIMIT_NAMES.join('|')}):[0-9a-f]{32}$`);
    for (const row of rows) {
      expect(row.bucket, row.bucket).toMatch(allowed);
    }
    // And every bucket is reachable through an `RL_*` override, so a limit can be
    // changed without a code change.
    for (const name of RATE_LIMIT_NAMES) {
      expect(rateLimitVarName(name)).toMatch(/^RL_[A-Z_]+$/);
    }
    const serialized = JSON.stringify(rows);
    for (const identifier of ['203.0.113', 'ratelimit@', 'example.test', 'unknown']) {
      expect(serialized).not.toContain(identifier);
    }
  });

  it('counts each refused request, so a persistent client gets no free pass', async () => {
    const rows = await queryRateLimits();
    // The register bucket for 203.0.113.10 was driven to four requests: two
    // allowed, two refused. All four were counted.
    const registerBuckets = rows.filter((row) => row.bucket.startsWith('register:'));
    expect(registerBuckets.some((row) => row.count > 2)).toBe(true);
  });

  it('can be turned off entirely, and then allows everything', async () => {
    const disabled = await startHarness('runtime', {
      auth: { ...TIGHT_LIMITS, RATE_LIMIT_ENABLED: 'false' },
      mcp: { ...GENEROUS, RATE_LIMIT_ENABLED: 'false' }
    });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await registerFrom('203.0.113.99', disabled);
        expect([200, 201]).toContain(response.status);
      }
    } finally {
      await disabled.close();
    }
  }, 300_000);
});
