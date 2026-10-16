import { ToolError } from '../shared/errors.js';
import { newId } from '../shared/crypto.js';
import type { EncryptedCredentials } from './credentials.js';
import type { SiteRow } from './registry-helpers.js';
import type { BluditEdition, SiteCapabilities } from '../bludit/capability-types.js';

// Re-exported so callers have one import site for the registry's shapes.
export { parseCapabilities, parseEditionLike, toPublicSite } from './registry-helpers.js';
export type { PublicSite, SiteRow } from './registry-helpers.js';


export async function listSiteRows(db: D1Database, userId: string): Promise<SiteRow[]> {
  const result = await db
    .prepare('SELECT * FROM sites WHERE user_id = ? AND status != ? ORDER BY label COLLATE NOCASE')
    .bind(userId, 'disabled')
    .all<SiteRow>();
  return result.results ?? [];
}

export interface SiteReference {
  /** Accepts a site id, an exact label, or a base URL / hostname. */
  ref: string;
}

/**
 * Resolve a caller-supplied site reference to exactly one owned site.
 *
 * Ambiguity is an error, never a silent first-match: a wrong-site write is the
 * most damaging failure mode this service has.
 */
export async function resolveSiteRow(
  db: D1Database,
  userId: string,
  reference: SiteReference | string
): Promise<SiteRow> {
  const ref = (typeof reference === 'string' ? reference : reference.ref).trim();
  if (ref === '') {
    throw new ToolError('invalid_input', 'A site reference is required (site id, label, or base URL).');
  }

  const rows = await listSiteRows(db, userId);
  if (rows.length === 0) {
    throw new ToolError('not_found', 'This account has no connected Bludit sites yet.');
  }

  const byId = rows.filter((row) => row.id === ref);
  if (byId.length === 1) return byId[0] as SiteRow;

  const lowered = ref.toLowerCase();
  const byLabel = rows.filter((row) => row.label.toLowerCase() === lowered);
  if (byLabel.length === 1) return byLabel[0] as SiteRow;

  const byUrl = rows.filter((row) => {
    const base = row.base_url.toLowerCase();
    if (base === lowered) return true;
    try {
      return new URL(base).hostname.toLowerCase() === lowered;
    } catch {
      return false;
    }
  });
  if (byUrl.length === 1) return byUrl[0] as SiteRow;

  const candidates = [...byLabel, ...byUrl];
  if (candidates.length > 1) {
    throw new ToolError('ambiguous_site', 'That reference matches more than one connected site.', {
      candidates: candidates.map((row) => ({ id: row.id, label: row.label, baseUrl: row.base_url }))
    });
  }

  throw new ToolError('not_found', 'No connected site matched that reference.', {
    available: rows.map((row) => ({ id: row.id, label: row.label, baseUrl: row.base_url }))
  });
}


export interface InsertSiteInput {
  userId: string;
  label: string;
  baseUrl: string;
  edition: BluditEdition;
  credentials: EncryptedCredentials;
  capabilities: SiteCapabilities | undefined;
  status?: 'connected' | 'error';
  lastError?: string;
}

export async function insertSite(db: D1Database, input: InsertSiteInput): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM sites WHERE user_id = ? AND base_url = ?')
    .bind(input.userId, input.baseUrl)
    .first<{ id: string }>();
  if (existing) {
    throw new ToolError('conflict', 'That Bludit site is already connected to this account.', {
      siteId: existing.id
    });
  }

  const id = newId('site');
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sites (
         id, user_id, label, base_url, edition, bludit_version,
         api_token_enc, auth_token_enc, wizard_api_key_enc, wizard_api_base,
         capabilities_json, status, last_error, created_at, updated_at, last_checked_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      input.userId,
      input.label,
      input.baseUrl,
      input.edition,
      '',
      input.credentials.api_token_enc,
      input.credentials.auth_token_enc,
      input.credentials.wizard_api_key_enc,
      input.credentials.wizard_api_base,
      JSON.stringify(input.capabilities ?? {}),
      input.status ?? 'connected',
      input.lastError ?? '',
      now,
      now,
      input.capabilities ? now : 0
    )
    .run();
  return id;
}

export async function updateSiteCapabilities(
  db: D1Database,
  userId: string,
  siteId: string,
  capabilities: SiteCapabilities
): Promise<void> {
  await db
    .prepare('UPDATE sites SET capabilities_json = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(JSON.stringify(capabilities), capabilities.checkedAt, Date.now(), siteId, userId)
    .run();
}

export async function markSiteStatus(
  db: D1Database,
  userId: string,
  siteId: string,
  status: 'connected' | 'error' | 'disabled',
  lastError = ''
): Promise<void> {
  await db
    .prepare('UPDATE sites SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(status, lastError.slice(0, 500), Date.now(), siteId, userId)
    .run();
}

export async function deleteSite(db: D1Database, userId: string, siteId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?').bind(siteId, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}
