/**
 * Audit log.
 *
 * Records *that* a tool ran, against which site, for which account and OAuth
 * client, and with what outcome. It never records page content, credentials, or
 * a URL carrying a token.
 */

import { newId } from '../shared/crypto.js';

export interface AuditEntry {
  userId: string;
  siteId?: string;
  clientId?: string;
  tool: string;
  outcome: 'ok' | 'denied' | 'error';
  detail?: string;
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (id, user_id, site_id, client_id, tool, outcome, detail, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .bind(
        newId('audit'),
        entry.userId,
        entry.siteId ?? '',
        entry.clientId ?? '',
        entry.tool.slice(0, 64),
        entry.outcome,
        (entry.detail ?? '').slice(0, 300),
        Date.now()
      )
      .run();
  } catch {
    // Auditing must never turn a successful operation into a failed one.
  }
}

export async function recentAudit(db: D1Database, userId: string, limit = 50): Promise<
  Array<{ tool: string; outcome: string; site_id: string; client_id: string; created_at: number }>
> {
  const result = await db
    .prepare(
      'SELECT tool, outcome, site_id, client_id, created_at FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .bind(userId, Math.min(limit, 200))
    .all<{ tool: string; outcome: string; site_id: string; client_id: string; created_at: number }>();
  return result.results ?? [];
}
