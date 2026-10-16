/**
 * Drives the site-connection flow through the authorization server's own HTML
 * pages, the way a person would. Nothing is inserted into D1 directly, so the
 * tests exercise CSRF handling, challenge verification and capability probing
 * for real.
 */

import type { WorkerHandle } from 'wrangler';
import { AUTH_ORIGIN } from './index.js';
import type { Account } from './oauth-client.js';

export interface ConnectSiteInput {
  siteUrl: string;
  apiToken: string;
  authToken?: string;
  wizardApiKey?: string;
  label?: string;
  edition?: 'community' | 'pro' | 'unknown';
}

export interface ConnectSiteOutcome {
  ok: boolean;
  siteId?: string;
  challenge: string;
  /** Full HTML of the response, for asserting on rendered errors. */
  html: string;
  status: number;
}

function csrfFrom(html: string): string {
  const match = /name="csrf" value="([^"]*)"/.exec(html);
  if (!match) throw new Error('No CSRF token in page');
  return match[1] as string;
}

function challengeFrom(html: string): string {
  const match = /<code class="token">([^<]+)<\/code>/.exec(html);
  if (!match) throw new Error('No pairing challenge in page');
  return (match[1] as string).trim();
}

/** Step 1: generate a pairing challenge. Returns the challenge and the page. */
export async function requestChallenge(
  auth: WorkerHandle,
  account: Account,
  options: { label?: string; baseUrl?: string } = {}
): Promise<{ challenge: string; html: string }> {
  const sitesPage = await auth.fetch(`${AUTH_ORIGIN}/sites`, { headers: { cookie: account.jar.header() } });
  if (sitesPage.status !== 200) {
    throw new Error(`Could not load /sites: ${sitesPage.status} ${await sitesPage.text()}`);
  }
  account.jar.absorb(sitesPage);
  const csrf = csrfFrom(await sitesPage.text());

  const response = await auth.fetch(`${AUTH_ORIGIN}/sites/challenge`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf,
      label: options.label ?? 'Test site',
      baseUrl: options.baseUrl ?? ''
    }).toString()
  });
  const html = await response.text();
  if (response.status !== 200) {
    throw new Error(`Challenge request failed: ${response.status} ${html.slice(0, 400)}`);
  }
  return { challenge: challengeFrom(html), html };
}

/** Step 2 and 3: submit the site details and follow the redirect. */
export async function submitSite(
  auth: WorkerHandle,
  account: Account,
  challenge: string,
  input: ConnectSiteInput
): Promise<ConnectSiteOutcome> {
  const page = await auth.fetch(`${AUTH_ORIGIN}/sites`, { headers: { cookie: account.jar.header() } });
  account.jar.absorb(page);
  const csrf = csrfFrom(await page.text());

  const response = await auth.fetch(`${AUTH_ORIGIN}/sites/connect`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf,
      challenge,
      baseUrl: input.siteUrl,
      label: input.label ?? 'Test site',
      edition: input.edition ?? 'unknown',
      apiToken: input.apiToken,
      authToken: input.authToken ?? '',
      wizardApiKey: input.wizardApiKey ?? '',
      wizardApiBase: ''
    }).toString(),
    redirect: 'manual'
  });
  account.jar.absorb(response);
  const html = await response.text();

  if (response.status === 303) {
    const location = response.headers.get('location') ?? '';
    const siteId = new URL(location, AUTH_ORIGIN).searchParams.get('connected') ?? undefined;
    return { ok: true, siteId, challenge, html, status: response.status };
  }
  return { ok: false, challenge, html, status: response.status };
}

/** Convenience: challenge + submit in one call. */
export async function connectSite(
  auth: WorkerHandle,
  account: Account,
  input: ConnectSiteInput
): Promise<ConnectSiteOutcome> {
  const { challenge } = await requestChallenge(auth, account, {
    label: input.label,
    baseUrl: input.siteUrl
  });
  return submitSite(auth, account, challenge, input);
}

/** Publish the challenge at the well-known path, then connect. */
export async function connectSiteWithWellKnownFile(
  auth: WorkerHandle,
  account: Account,
  input: ConnectSiteInput,
  publish: (challenge: string) => void
): Promise<ConnectSiteOutcome> {
  const { challenge } = await requestChallenge(auth, account, {
    label: input.label,
    baseUrl: input.siteUrl
  });
  publish(challenge);
  return submitSite(auth, account, challenge, input);
}
