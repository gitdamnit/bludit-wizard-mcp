/**
 * Connect a Bludit site to an account.
 *
 * Order of operations matters and is fixed:
 *   1. Validate the URL statically (SSRF policy) and normalize it.
 *   2. Resolve the account's pairing challenge, still unconsumed and unexpired.
 *   3. Ask the live site to prove it received that challenge.
 *   4. Only then probe capabilities, encrypt, and store.
 *   5. Consume the challenge last, so a failed store leaves it reusable.
 *
 * Step 3 is the security boundary. Steps 1–2 prove the *user* intended this;
 * step 3 proves the *site* is under their control. A pasted API token alone is
 * never treated as proof of ownership.
 */

import { BluditClient } from '../bludit/client.js';
import { detectCapabilities } from '../bludit/capabilities.js';
import type { BluditEdition, SiteCapabilities } from '../bludit/capability-types.js';
import { ToolError } from '../shared/errors.js';
import { logger } from '../shared/log.js';
import { newId } from '../shared/crypto.js';
import { checkSiteUrl, normalizeBaseUrl, safeFetch, SsrfBlockedError, type UrlPolicy } from '../shared/ssrf.js';
import type { SharedConfig } from '../shared/env.js';
import { encryptCredentials } from './credentials.js';
import {
  consumeChallenge,
  findChallenge,
  verifyWellKnownBody,
  verifyWizardProof,
  WELL_KNOWN_CHALLENGE_PATH
} from './pairing.js';

export interface SiteCredentialsInput {
  apiToken: string;
  authToken: string;
  wizardApiKey: string;
  wizardApiBase: string;
}

export interface ConnectSiteInput {
  userId: string;
  /** The challenge secret the account generated, shown once. */
  challenge: string;
  baseUrl: string;
  label: string;
  declaredEdition?: BluditEdition;
  credentials: SiteCredentialsInput;
}

export interface ConnectSiteResult {
  siteId: string;
  baseUrl: string;
  label: string;
  proofMethod: ProofMethod;
  capabilities: SiteCapabilities;
}

export type ProofMethod = 'wizard_hmac' | 'well-known-file';

export interface ConnectDeps {
  db: D1Database;
  /** Needs the credential key and the session secret that keys challenge hashes. */
  env: SharedConfig & { SESSION_SECRET: string };
  policy: UrlPolicy;
  /** Injectable transport, so the pairing proof can be tested deterministically. */
  fetchImpl?: typeof safeFetch;
}

export async function connectSite(deps: ConnectDeps, input: ConnectSiteInput): Promise<ConnectSiteResult> {
  const urlCheck = checkSiteUrl(input.baseUrl, deps.policy);
  if (!urlCheck.ok || !urlCheck.url) {
    throw new ToolError('invalid_input', urlCheck.reason ?? 'The site URL was rejected.');
  }
  const baseUrl = normalizeBaseUrl(urlCheck.url);

  if (input.credentials.apiToken.trim() === '') {
    throw new ToolError('invalid_input', 'The Bludit API token is required.');
  }

  // Step 2: the challenge must belong to this account and still be usable.
  const challengeRow = await findChallenge(deps.db, deps.env.SESSION_SECRET, input.userId, input.challenge);
  if (challengeRow.base_url !== '' && challengeRow.base_url !== baseUrl) {
    throw new ToolError('conflict', 'This pairing challenge was issued for a different site URL.');
  }

  const credentials: SiteCredentialsInput = {
    apiToken: input.credentials.apiToken.trim(),
    authToken: input.credentials.authToken.trim(),
    wizardApiKey: input.credentials.wizardApiKey.trim(),
    wizardApiBase: input.credentials.wizardApiBase.trim() || `${baseUrl}/api/wizard`
  };

  const client = new BluditClient({ baseUrl, ...credentials }, { policy: deps.policy });

  // Step 3: the site must prove it received the challenge.
  const proofMethod = await proveSiteControl(deps, client, input.challenge.trim(), credentials);

  // Step 4: learn what the site supports, then store it encrypted.
  const capabilities = await detectCapabilities(client, {
    declaredEdition: input.declaredEdition ?? 'unknown'
  });

  const label = input.label.trim() || new URL(baseUrl).hostname;
  const siteId = newId('site');
  const encrypted = await encryptCredentials(deps.env, siteId, credentials);

  const now = Date.now();
  await deps.db
    .prepare(
      `INSERT INTO sites (
         id, user_id, label, base_url, edition, bludit_version,
         api_token_enc, auth_token_enc, wizard_api_key_enc, wizard_api_base,
         capabilities_json, status, last_error, created_at, updated_at, last_checked_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      siteId,
      input.userId,
      label,
      baseUrl,
      input.declaredEdition ?? 'unknown',
      '',
      encrypted.api_token_enc,
      encrypted.auth_token_enc,
      encrypted.wizard_api_key_enc,
      encrypted.wizard_api_base,
      JSON.stringify(capabilities),
      'connected',
      '',
      now,
      now,
      capabilities.checkedAt
    )
    .run();

  // Step 5: only now is the challenge spent.
  await consumeChallenge(deps.db, input.userId, challengeRow.id, now);

  logger.info('site.connected', { siteId, proofMethod, edition: input.declaredEdition ?? 'unknown' });

  return { siteId, baseUrl, label, proofMethod, capabilities };
}

async function proveSiteControl(
  deps: ConnectDeps,
  client: BluditClient,
  challenge: string,
  credentials: SiteCredentialsInput
): Promise<ProofMethod> {
  const failures: string[] = [];

  // Preferred: the Wizard extension proves possession of its own API key.
  if (credentials.wizardApiKey !== '') {
    try {
      const pair = await client.wizardPair(challenge);
      if (pair.ok === true && typeof pair.proof === 'string' && pair.proof !== '') {
        if (await verifyWizardProof(credentials.wizardApiKey, challenge, pair.proof)) {
          return 'wizard_hmac';
        }
        failures.push('the Wizard extension returned a proof that did not verify');
      } else {
        failures.push('the Wizard extension did not return a pairing proof');
      }
    } catch (error) {
      failures.push(
        error instanceof ToolError && error.code === 'capability_unavailable'
          ? 'the Wizard extension is not installed at /api/wizard'
          : 'the Wizard extension pairing call failed'
      );
    }
  } else {
    failures.push('no Wizard extension key was supplied');
  }

  // Fallback: a file the site owner publishes themselves. Works without any
  // plugin, which matters because the Wizard extension is optional.
  const wellKnownUrl = new URL(`${client.baseUrl}${WELL_KNOWN_CHALLENGE_PATH}`);
  const fetchImpl = deps.fetchImpl ?? safeFetch;
  try {
    const response = await fetchImpl(wellKnownUrl, deps.policy, {
      method: 'GET',
      timeoutMs: 10_000,
      maxBytes: 4096
    });
    if (response.status === 200 && verifyWellKnownBody(challenge, response.text)) {
      return 'well-known-file';
    }
    failures.push(
      response.status === 200
        ? 'the ownership file exists but does not contain this challenge'
        : `the ownership file returned HTTP ${response.status}`
    );
  } catch (error) {
    failures.push(
      error instanceof SsrfBlockedError
        ? 'the ownership file URL was rejected by the SSRF policy'
        : 'the ownership file could not be fetched'
    );
  }

  throw new ToolError(
    'forbidden',
    'The site did not prove it received this pairing challenge, so it was not connected.',
    {
      tried: failures,
      guidance: [
        'Install the Bludit Wizard extension and supply its GPT Action API key, or',
        `publish the challenge at ${client.baseUrl}${WELL_KNOWN_CHALLENGE_PATH}`
      ]
    }
  );
}
