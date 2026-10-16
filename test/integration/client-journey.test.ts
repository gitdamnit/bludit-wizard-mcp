/**
 * The nine-step client journey.
 *
 * The compatibility requirement names nine things a client must be able to do.
 * This walks all nine, twice: once with an OAuth access token, and once with a
 * personal access token, because the two credential types must be equivalent in
 * everything except how the token was obtained.
 *
 * Every result is asserted, and the same walk is what the "read operation",
 * "proposed edit", "approved write" and "verified result" columns of
 * `CLIENT_COMPATIBILITY_MATRIX.md` report.
 *
 *   1. OAuth authorization          6. draft creation
 *   2. site selection              7. edit proposal
 *   3. page listing                8. explicit approval
 *   4. content retrieval           9. edit application and verification
 *   5. (GET /api/settings, the settings:read scope)
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
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

const FULL_SCOPES = 'sites:read pages:read pages:write settings:read offline_access';

let harness: Harness;
let site: MockBludit;
let as: DiscoveredServer;
let account: Account;
let siteId: string;

/** A step result, recorded so the journey reads as a narrative. */
type StepOutcome = { step: string; credential: string; outcome: string };

const journey: StepOutcome[] = [];

function record(step: string, credential: string, outcome: string): void {
  journey.push({ step, credential, outcome });
}

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'journey-api-token',
    authToken: 'journey-auth-token',
    siteTitle: 'Journey site',
    siteDescription: 'A site used by the client-journey test',
    pages: [
      { title: 'About us', description: 'Who we are', content: '# About us\n\nWe build things.\n', type: 'published', tags: ['company'] }
    ]
  });
  harness = await startHarness();
  as = await discover(harness.mcp, harness.auth);
  account = await createAccount(harness.auth, 'journey@example.test');

  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    account,
    { siteUrl: site.url, apiToken: 'journey-api-token', authToken: 'journey-auth-token', label: 'Journey site' },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) throw new Error(`Setup failed: ${outcome.html.slice(0, 300)}`);
  siteId = outcome.siteId as string;
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

/** Step 1 for an OAuth client: discovery, registration, PKCE, consent, token. */
async function oauthToken(suffix: string): Promise<string> {
  const client = await registerClient(harness.auth, as, `http://127.0.0.1:${7900 + suffix.length}/callback`);
  const tokens = await accessToken(harness.auth, account, { as, client, scope: FULL_SCOPES });
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  record('1. OAuth authorization', `oauth:${suffix}`, 'authorized');
  return tokens.access_token;
}

/** Step 1 for a header-only client: a personal access token from the UI. */
async function patToken(label: string): Promise<string> {
  const page = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, { headers: { cookie: account.jar.header() } });
  account.jar.absorb(page);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] as string;
  const scopes = [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))];
  const form = new URLSearchParams({ csrf, label, ttlDays: '90' });
  for (const scope of scopes) form.append('scope', scope);

  const response = await harness.auth.fetch(`${AUTH_ORIGIN}/tokens`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  account.jar.absorb(response);
  const token = /<code class="token">([^<]+)<\/code>/.exec(await response.text())?.[1]?.trim();
  if (!token) throw new Error('the token page did not return a token');
  record('1. OAuth authorization', `pat:${label}`, 'issued instead (client cannot do OAuth)');
  return token;
}

async function walk(token: string, credential: string): Promise<void> {
  // 2. Site selection
  const sites = await callTool(harness.mcp, token, 'list_sites', { include_capabilities: true });
  expect(sites.isError, `${credential} list_sites`).toBe(false);
  expect((sites.data as { count: number }).count).toBe(1);
  const selected = await callTool(harness.mcp, token, 'select_site', { site: siteId });
  expect(selected.isError, `${credential} select_site`).toBe(false);
  record('2. Site selection', credential, 'one site resolved by id');

  // 3. Page listing
  const listed = await callTool(harness.mcp, token, 'list_pages', { site: siteId, numberOfItems: -1 });
  expect(listed.isError, `${credential} list_pages`).toBe(false);
  const pages = (listed.data as { pages: Array<{ key: string; title: string }> }).pages;
  expect(pages.length).toBeGreaterThan(0);
  record('3. Page listing', credential, `${pages.length} page(s)`);

  // 4. Content retrieval
  const target = pages[0] as { key: string };
  const page = await callTool(harness.mcp, token, 'get_page', { site: siteId, key: target.key });
  expect(page.isError, `${credential} get_page`).toBe(false);
  const revision = (page.data as { revision: string; page: { contentRaw: string } }).revision;
  expect((page.data as { page: { contentRaw: string } }).page.contentRaw.length).toBeGreaterThan(0);
  expect(revision).toMatch(/^[0-9a-f]{64}$/);
  record('4. Content retrieval', credential, `revision ${revision.slice(0, 12)}…`);

  // 5. Settings, which needs its own scope
  const settings = await callTool(harness.mcp, token, 'get_website_settings', { site: siteId });
  expect(settings.isError, `${credential} get_website_settings`).toBe(false);
  expect((settings.data as { settings: { title: string } }).settings.title).toBe('Journey site');
  record('5. Settings', credential, 'title read');

  // 6. Draft creation, verified by a read-back
  const title = `Journey draft ${credential} ${Date.now()}`;
  const created = await callTool(harness.mcp, token, 'create_page', {
    site: siteId,
    title,
    content: `# ${title}\n\nCreated during the client journey.\n`,
    type: 'draft',
    tags: 'journey'
  });
  expect(created.isError, `${credential} create_page`).toBe(false);
  const draftKey = (created.data as { key: string; verified: boolean }).key;
  expect((created.data as { verified: boolean }).verified).toBe(true);
  expect(site.pages.get(draftKey)?.type).toBe('draft');
  record('6. Draft creation', credential, `created ${draftKey}, verified`);

  // 7. Edit proposal, which writes nothing
  const before = site.pages.get(draftKey)?.description;
  const proposed = await callTool(harness.mcp, token, 'propose_page_edit', {
    site: siteId,
    key: draftKey,
    operation: 'edit',
    description: 'Proposed during the journey',
    title: `${title} (reviewed)`
  });
  expect(proposed.isError, `${credential} propose_page_edit`).toBe(false);
  const proposalId = (proposed.data as { proposalId: string; preview: unknown }).proposalId;
  expect((proposed.data as { preview: unknown }).preview).toBeTruthy();
  expect(site.pages.get(draftKey)?.description).toBe(before);
  record('7. Edit proposal', credential, `${proposalId}, site unchanged`);

  // Also preview the change through the separate preview tool.
  const preview = await callTool(harness.mcp, token, 'preview_page_changes', {
    site: siteId,
    key: draftKey,
    content: '# Previewed\n'
  });
  expect(preview.isError, `${credential} preview_page_changes`).toBe(false);
  expect((preview.data as { wouldChange: boolean }).wouldChange).toBe(true);

  // 8. Explicit approval
  const unconfirmed = await callTool(harness.mcp, token, 'apply_approved_edit', {
    site: siteId,
    proposal_id: proposalId
  });
  expect(unconfirmed.isError, `${credential} apply without confirm`).toBe(true);
  expect(unconfirmed.raw).toContain('confirm');
  record('8. Explicit approval', credential, 'refused without confirm: true');

  // 9. Application and verification
  const applied = await callTool(harness.mcp, token, 'apply_approved_edit', {
    site: siteId,
    proposal_id: proposalId,
    confirm: true
  });
  expect(applied.isError, `${credential} apply_approved_edit`).toBe(false);
  const afterRevision = (applied.data as { revisionAfter: string; verified: boolean }).revisionAfter;
  expect((applied.data as { verified: boolean }).verified).toBe(true);
  expect(afterRevision).not.toBe(revision);
  expect(site.pages.get(draftKey)?.description).toBe('Proposed during the journey');

  const verified = await callTool(harness.mcp, token, 'verify_page_update', {
    site: siteId,
    key: draftKey,
    expected_revision: afterRevision
  });
  expect(verified.isError, `${credential} verify_page_update`).toBe(false);
  expect((verified.data as { ok: boolean; checks: Array<{ ok: boolean }> }).ok).toBe(true);
  record('9. Application and verification', credential, 'applied, read back, revision confirmed');
}

describe('the nine-step journey with an OAuth token', () => {
  it('completes every step', async () => {
    await walk(await oauthToken('one'), 'oauth');
  }, 300_000);
});

describe('the nine-step journey with a personal access token', () => {
  it('completes every step identically', async () => {
    await walk(await patToken('journey'), 'pat');
  }, 300_000);
});

describe('the journey record', () => {
  it('covers all nine steps for both credential types', () => {
    const steps = new Set(journey.map((entry) => entry.step));
    expect([...steps].sort()).toEqual(
      [
        '1. OAuth authorization',
        '2. Site selection',
        '3. Page listing',
        '4. Content retrieval',
        '5. Settings',
        '6. Draft creation',
        '7. Edit proposal',
        '8. Explicit approval',
        '9. Application and verification'
      ].sort()
    );
    const credentials = new Set(journey.map((entry) => entry.credential.split(':')[0]));
    expect([...credentials].sort()).toEqual(['oauth', 'pat']);
  });

  it('records a refusal at the approval gate rather than a silent write', () => {
    const gate = journey.filter((entry) => entry.step === '8. Explicit approval');
    expect(gate).toHaveLength(2);
    for (const entry of gate) expect(entry.outcome).toContain('refused without confirm');
  });
});
