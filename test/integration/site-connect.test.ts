/**
 * Site-connection security.
 *
 * Connecting a Bludit site is the one flow where a user hands this service a
 * credential for a system it does not own, so it is the flow with the most to
 * prove: the pairing challenge must be single-use, bound to the account and the
 * URL, and the site must actually echo it. Credentials must land in D1 as
 * ciphertext.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { startHarness, type Harness } from '../harness/index.js';
import { createAccount, type Account } from '../harness/oauth-client.js';
import { connectSite, connectSiteWithWellKnownFile, requestChallenge, submitSite } from '../harness/site.js';

let harness: Harness;
let site: MockBludit;
let account: Account;

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'api-secret-value',
    authToken: 'auth-secret-value',
    wizardApiKey: 'wizard-secret-value',
    wizardInstalled: false,
    pages: [{ title: 'Home', content: '# Home\n', type: 'published' }]
  });
  harness = await startHarness();
  account = await createAccount(harness.auth, 'connect@example.test');
}, 240_000);

afterEach(() => {
  site.reset();
  site.setChallenge(null);
});

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

/** Extract the user-facing error from a rendered connect page, for diagnostics. */
function errorText(outcome: { html: string }): string {
  const message = /<p class="error">([^<]*)<\/p>/.exec(outcome.html)?.[1] ?? '(no error text)';
  const details = /<pre class="muted"[^>]*>([\s\S]*?)<\/pre>/.exec(outcome.html)?.[1] ?? '';
  return `${message} ${details}`.trim();
}

/** A fresh account per test: `sites` is unique per (user, base_url). */
async function freshAccount(name: string): Promise<Account> {
  return createAccount(harness.auth, `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`);
}

/** Read a row back from the local D1 database through the test-only worker. */
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

describe('proof of site control', () => {
  it('refuses a connection with no proof at all', async () => {
    const outcome = await connectSite(harness.auth, account, {
      siteUrl: site.url,
      apiToken: 'api-secret-value',
      authToken: 'auth-secret-value',
      label: 'No proof'
    });
    expect(outcome.ok).toBe(false);
    expect(errorText(outcome)).toContain('did not prove it received this pairing challenge');
    // The failure explains how to succeed rather than leaving the user stuck.
    expect(outcome.html).toContain('bludit-wizard-challenge.txt');
  });

  it('refuses a well-known file that contains a different challenge', async () => {
    const { challenge } = await requestChallenge(harness.auth, account, { label: 'Wrong file' });
    site.setChallenge('a-completely-different-value');
    const outcome = await submitSite(harness.auth, account, challenge, {
      siteUrl: site.url,
      apiToken: 'api-secret-value',
      label: 'Wrong file'
    });
    expect(outcome.ok).toBe(false);
    expect(errorText(outcome)).toContain('did not prove it received this pairing challenge');
  });

  it('refuses an unknown challenge value', async () => {
    const unknownAccount = await freshAccount('unknown');
    site.setChallenge('not-a-real-challenge');
    const outcome = await submitSite(harness.auth, unknownAccount, 'a-challenge-that-was-never-issued', {
      siteUrl: site.url,
      apiToken: 'api-secret-value',
      label: 'Unknown challenge'
    });
    expect(outcome.ok).toBe(false);
    expect(errorText(outcome)).toContain('not recognised');
  });

  it('accepts a challenge echoed at the well-known path, and then records the site', async () => {
    const outcome = await connectSiteWithWellKnownFile(
      harness.auth,
      await freshAccount('legit'),
      { siteUrl: site.url, apiToken: 'api-secret-value', authToken: 'auth-secret-value', label: 'Legit' },
      (challenge) => site.setChallenge(challenge)
    );
    expect(outcome.ok, outcome.html.slice(0, 400)).toBe(true);
    expect(outcome.siteId).toBeTruthy();

    const rows = await query<{ label: string; edition: string; base_url: string }>(
      'SELECT label, edition, base_url FROM sites WHERE id = ?',
      [outcome.siteId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Legit');
  });

  it('refuses to reuse a spent challenge', async () => {
    const reuseAccount = await freshAccount('reuse');
    const { challenge } = await requestChallenge(harness.auth, reuseAccount, { label: 'Reuse' });
    site.setChallenge(challenge);

    const first = await submitSite(harness.auth, reuseAccount, challenge, {
      siteUrl: site.url,
      apiToken: 'api-secret-value',
      authToken: 'auth-secret-value',
      label: 'Reuse'
    });
    expect(first.ok, first.html.slice(0, 300)).toBe(true);

    const second = await submitSite(harness.auth, reuseAccount, challenge, {
      siteUrl: site.url,
      apiToken: 'api-secret-value',
      authToken: 'auth-secret-value',
      label: 'Reuse'
    });
    expect(second.ok).toBe(false);
    expect(errorText(second)).toContain('already been used');
  });

  it('refuses a challenge issued for a different site URL', async () => {
    const { challenge } = await requestChallenge(harness.auth, account, {
      label: 'Bound to another URL',
      baseUrl: 'https://a-different-site.example.com'
    });
    site.setChallenge(challenge);
    const outcome = await submitSite(harness.auth, account, challenge, {
      siteUrl: 'https://another-site.example.com',
      apiToken: 'api-secret-value',
      label: 'Bound to another URL'
    });
    expect(outcome.ok).toBe(false);
    expect(errorText(outcome)).toContain('issued for a different site URL');
  });
});

describe('credential storage', () => {
  it('stores credentials as ciphertext, never as plaintext', async () => {
    const outcome = await connectSiteWithWellKnownFile(
      harness.auth,
      await freshAccount('encrypted'),
      {
        siteUrl: site.url,
        apiToken: 'api-secret-value',
        authToken: 'auth-secret-value',
        label: 'Encrypted at rest'
      },
      (challenge) => site.setChallenge(challenge)
    );
    expect(outcome.ok, outcome.html.slice(0, 300)).toBe(true);

    const rows = await query<{ api_token_enc: string; auth_token_enc: string; wizard_api_key_enc: string }>(
      'SELECT api_token_enc, auth_token_enc, wizard_api_key_enc FROM sites WHERE id = ?',
      [outcome.siteId]
    );
    const row = rows[0] as { api_token_enc: string; auth_token_enc: string; wizard_api_key_enc: string };
    expect(row.api_token_enc.startsWith('v1.')).toBe(true);
    expect(row.api_token_enc).not.toContain('api-secret-value');
    expect(row.auth_token_enc).not.toContain('auth-secret-value');
    expect(JSON.stringify(row)).not.toContain('secret-value');
  });

  it('decrypts correctly at call time, proven by the live site accepting the token', async () => {
    // The mock rejects a wrong API token with 401, so a successful capability
    // probe proves the stored ciphertext decrypted back to the right value.
    const outcome = await connectSiteWithWellKnownFile(
      harness.auth,
      await freshAccount('roundtrip'),
      { siteUrl: site.url, apiToken: 'api-secret-value', authToken: 'auth-secret-value', label: 'Round trip' },
      (challenge) => site.setChallenge(challenge)
    );
    expect(outcome.ok, outcome.html.slice(0, 300)).toBe(true);
    expect(outcome.html).toBeDefined();

    // The connection flow itself proves it: capability detection only reports
    // readOk when the site accepted the decrypted token.
    const request = site.requests.find((entry) => entry.pathname === '/api/pages');
    expect(request?.status).toBe(200);
  });
});

describe('the optional Wizard extension', () => {
  it('accepts an HMAC pairing proof when the extension is installed', async () => {
    const installed = await startMockBludit({
      apiToken: 'api-secret-value',
      authToken: 'auth-secret-value',
      wizardApiKey: 'wizard-secret-value',
      wizardInstalled: true
    });
    try {
      const wizardAccount = await createAccount(harness.auth, 'wizard@example.test');
      const { challenge } = await requestChallenge(harness.auth, wizardAccount, { label: 'Wizard site' });
      const outcome = await submitSite(harness.auth, wizardAccount, challenge, {
        siteUrl: installed.url,
        apiToken: 'api-secret-value',
        authToken: 'auth-secret-value',
        wizardApiKey: 'wizard-secret-value',
        label: 'Wizard site'
      });
      expect(outcome.ok, errorText(outcome)).toBe(true);

      // The extension was asked for a proof, and no ownership file was needed.
      expect(installed.requests.some((entry) => entry.pathname === '/api/wizard/pair')).toBe(true);
      expect(installed.requests.some((entry) => entry.pathname.includes('bludit-wizard-challenge'))).toBe(false);
    } finally {
      await installed.close();
    }
  });

  it('rejects a key the extension does not recognise', async () => {
    const installed = await startMockBludit({
      apiToken: 'api-secret-value',
      wizardApiKey: 'the-real-wizard-key',
      wizardInstalled: true
    });
    try {
      const wizardAccount = await freshAccount('wizard-wrong-key');
      const { challenge } = await requestChallenge(harness.auth, wizardAccount, { label: 'Wrong key' });

      const outcome = await submitSite(harness.auth, wizardAccount, challenge, {
        siteUrl: installed.url,
        apiToken: 'api-secret-value',
        wizardApiKey: 'a-key-that-does-not-match',
        label: 'Wrong key'
      });

      expect(outcome.ok).toBe(false);
      expect(errorText(outcome)).toContain('Wizard extension pairing call failed');
      expect(errorText(outcome)).toContain('ownership file');
    } finally {
      await installed.close();
    }
  });

  it('rejects a pairing proof that does not verify, even when the key is accepted', async () => {
    const broken = await startMockBludit({
      apiToken: 'api-secret-value',
      wizardApiKey: 'wizard-secret-value',
      wizardInstalled: true,
      wizardProofInvalid: true
    });
    try {
      const brokenAccount = await freshAccount('wizard-bad-proof');
      const { challenge } = await requestChallenge(harness.auth, brokenAccount, { label: 'Bad proof' });

      const outcome = await submitSite(harness.auth, brokenAccount, challenge, {
        siteUrl: broken.url,
        apiToken: 'api-secret-value',
        wizardApiKey: 'wizard-secret-value',
        label: 'Bad proof'
      });

      expect(outcome.ok).toBe(false);
      expect(errorText(outcome)).toContain('proof that did not verify');
      expect(errorText(outcome)).toContain('ownership file');
    } finally {
      await broken.close();
    }
  });
});
