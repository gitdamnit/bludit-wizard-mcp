/**
 * Pure presentation and parsing helpers for the site registry.
 *
 * Separated from `registry.ts` so the shapes a tool is allowed to see, and the
 * logic that strips secrets, can be tested directly — without a D1 binding and
 * without loading anything Workers-specific.
 */

import type { BluditEdition, SiteCapabilities } from '../bludit/capability-types.js';
import type { EncryptedCredentials } from './credentials.js';

export interface SiteRow extends EncryptedCredentials {
  id: string;
  user_id: string;
  label: string;
  base_url: string;
  edition: string;
  bludit_version: string;
  capabilities_json: string;
  status: string;
  last_error: string;
  created_at: number;
  updated_at: number;
  last_checked_at: number;
}

/** Site metadata safe to return to an MCP client. Never contains credentials. */
export interface PublicSite {
  id: string;
  label: string;
  baseUrl: string;
  edition: BluditEdition;
  status: string;
  lastError: string;
  createdAt: string;
  lastCheckedAt: string;
  wizardExtension: boolean;
  capabilities?: SiteCapabilities;
}

export function parseEditionLike(value: string | undefined | null): BluditEdition {
  return value === 'community' || value === 'pro' ? value : 'unknown';
}

export function parseCapabilities(json: string): SiteCapabilities | undefined {
  if (!json || json === '{}') return undefined;
  try {
    return JSON.parse(json) as SiteCapabilities;
  } catch {
    return undefined;
  }
}

/**
 * Project a row onto the fields a tool may see. Encrypted columns and the raw
 * capability blob are dropped: `toPublicSite` is the only way a row reaches a
 * caller, so a new column cannot leak by accident.
 */
export function toPublicSite(row: SiteRow, includeCapabilities = false): PublicSite {
  const capabilities = parseCapabilities(row.capabilities_json);
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    edition: parseEditionLike(row.edition),
    status: row.status,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    lastCheckedAt: row.last_checked_at > 0 ? new Date(row.last_checked_at).toISOString() : '',
    wizardExtension: row.wizard_api_base !== '' && row.wizard_api_key_enc !== '',
    ...(includeCapabilities && capabilities ? { capabilities } : {})
  };
}
