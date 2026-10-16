/**
 * Credential handling for connected Bludit sites.
 *
 * Plaintext credentials exist only inside a single request: they are decrypted,
 * used for one outbound call, and discarded. They are never written to D1,
 * never logged, and never returned by any MCP tool.
 *
 * Encryption is AES-256-GCM with the site id as additional authenticated data,
 * so a ciphertext cannot be copied from one site row to another.
 */

import type { BluditCredentials } from '../bludit/client.js';
import { intVar, type SharedConfig } from '../shared/env.js';
import { decryptSecret, encryptSecret } from '../shared/crypto.js';

/** Column shape carrying encrypted credentials in `sites`. */
export interface EncryptedCredentials {
  api_token_enc: string;
  auth_token_enc: string;
  wizard_api_key_enc: string;
  wizard_api_base: string;
}

export interface PlainCredentials {
  apiToken: string;
  authToken: string;
  wizardApiKey: string;
  wizardApiBase: string;
}

export function credentialKey(env: SharedConfig): string {
  return env.SITE_CREDENTIAL_KEY;
}

export function credentialKeyVersion(env: SharedConfig): number {
  return intVar(env.CREDENTIAL_KEY_VERSION, 1);
}

export async function encryptCredentials(
  env: SharedConfig,
  siteId: string,
  credentials: PlainCredentials
): Promise<EncryptedCredentials> {
  const key = credentialKey(env);
  const [apiTokenEnc, authTokenEnc, wizardApiKeyEnc] = await Promise.all([
    encryptSecret(key, credentials.apiToken, siteId),
    encryptSecret(key, credentials.authToken, siteId),
    encryptSecret(key, credentials.wizardApiKey, siteId)
  ]);
  return {
    api_token_enc: apiTokenEnc,
    auth_token_enc: authTokenEnc,
    wizard_api_key_enc: wizardApiKeyEnc,
    wizard_api_base: credentials.wizardApiBase
  };
}

export async function decryptCredentials(
  env: SharedConfig,
  siteId: string,
  row: EncryptedCredentials
): Promise<PlainCredentials> {
  const key = credentialKey(env);
  const [apiToken, authToken, wizardApiKey] = await Promise.all([
    decryptSecret(key, row.api_token_enc, siteId),
    decryptSecret(key, row.auth_token_enc, siteId),
    decryptSecret(key, row.wizard_api_key_enc, siteId)
  ]);
  return { apiToken, authToken, wizardApiKey, wizardApiBase: row.wizard_api_base };
}

export async function toBluditCredentials(
  env: SharedConfig,
  siteId: string,
  baseUrl: string,
  row: EncryptedCredentials
): Promise<BluditCredentials> {
  const plain = await decryptCredentials(env, siteId, row);
  return {
    baseUrl,
    apiToken: plain.apiToken,
    authToken: plain.authToken,
    wizardApiKey: plain.wizardApiKey,
    wizardApiBase: plain.wizardApiBase || `${baseUrl}/api/wizard`
  };
}
