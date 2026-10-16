/**
 * Per-invocation tool context.
 *
 * Everything a tool is allowed to do is derived here from the *verified* token,
 * never from tool arguments:
 *  - `userId` and `clientId` come from the validated access token.
 *  - `scopes` come from the token, and every tool re-checks its own scope.
 *  - The site lookup is scoped by `userId`, so a site id from another account
 *    is simply not found.
 *
 * Tool arguments can therefore only ever select *which of this account's own
 * sites* to act on, never widen access.
 */

import { BluditClient } from '../../bludit/client.js';
import type { AuthProps, McpEnv } from '../../shared/env.js';
import { ToolError } from '../../shared/errors.js';
import { hasScopes, scopesForTool } from '../../shared/scopes.js';
import { urlPolicyFor } from '../../shared/policy.js';
import { resolveSiteRow, toPublicSite, type PublicSite, type SiteRow } from '../../sites/registry.js';
import { toBluditCredentials } from '../../sites/credentials.js';
import { recordAudit } from '../../audit/log.js';
import { errorSummary, logger } from '../../shared/log.js';
import type { UrlPolicy } from '../../shared/ssrf.js';

export interface ToolContext {
  env: McpEnv;
  db: D1Database;
  userId: string;
  clientId: string;
  scopes: string[];
  props: AuthProps;
  policy: UrlPolicy;
}

export function buildToolContext(env: McpEnv, props: AuthProps, auth: { scope: string[]; clientId?: string }): ToolContext {
  return {
    env,
    db: env.DB,
    userId: props.userId,
    clientId: auth.clientId ?? 'unknown',
    scopes: auth.scope,
    props,
    policy: urlPolicyFor(env)
  };
}

/**
 * Enforce a tool's scope on the server. This runs inside the tool callback as
 * well as in the HTTP pre-flight, so a bug in the pre-flight cannot silently
 * authorise a write.
 */
export function requireToolScope(ctx: ToolContext, tool: string): void {
  const needed = scopesForTool(tool);
  if (!hasScopes(ctx.scopes, needed)) {
    throw new ToolError('forbidden', `This client is not authorized for ${tool}.`, {
      requiredScopes: needed,
      grantedScopes: ctx.scopes
    });
  }
}

export interface ResolvedSite {
  row: SiteRow;
  public: PublicSite;
  client: BluditClient;
}

/** Resolve a site reference and build a client with freshly decrypted credentials. */
export async function resolveSite(ctx: ToolContext, reference: string): Promise<ResolvedSite> {
  const row = await resolveSiteRow(ctx.db, ctx.userId, reference);
  const credentials = await toBluditCredentials(ctx.env, row.id, row.base_url, row);
  const client = new BluditClient(credentials, { policy: ctx.policy });
  return { row, public: toPublicSite(row), client };
}

/**
 * The site to act on when the caller did not name one.
 *
 * With exactly one connected site this is unambiguous. With several, guessing
 * would be dangerous, so the caller is asked to be explicit.
 */
export async function defaultSite(ctx: ToolContext): Promise<ResolvedSite> {
  const rows = await ctx.db
    .prepare('SELECT * FROM sites WHERE user_id = ? AND status != ? ORDER BY label COLLATE NOCASE')
    .bind(ctx.userId, 'disabled')
    .all<SiteRow>();
  const list = rows.results ?? [];
  if (list.length === 0) throw new ToolError('not_found', 'This account has no connected Bludit sites yet.');
  if (list.length > 1) {
    throw new ToolError('ambiguous_site', 'Several sites are connected. Name one explicitly with the `site` argument.', {
      available: list.map((row) => ({ id: row.id, label: row.label, baseUrl: row.base_url }))
    });
  }
  return resolveSite(ctx, (list[0] as SiteRow).id);
}

/** Resolve an explicit site, or fall back to the sole connected site. */
export async function siteFor(ctx: ToolContext, reference: string | undefined): Promise<ResolvedSite> {
  if (reference && reference.trim() !== '') return resolveSite(ctx, reference);
  return defaultSite(ctx);
}

export interface AuditOptions {
  tool: string;
  outcome: 'ok' | 'denied' | 'error';
  siteId?: string;
  detail?: string;
}

export async function audit(ctx: ToolContext, options: AuditOptions): Promise<void> {
  await recordAudit(ctx.db, {
    userId: ctx.userId,
    clientId: ctx.clientId,
    siteId: options.siteId ?? '',
    tool: options.tool,
    outcome: options.outcome,
    detail: options.detail ?? ''
  });
}

/**
 * Wrap a tool body so every invocation produces one audit record and any
 * unexpected failure is logged without leaking a credential.
 */
export async function withAudit<T>(
  ctx: ToolContext,
  tool: string,
  run: () => Promise<{ siteId?: string; result: T }>
): Promise<T> {
  try {
    const { siteId, result } = await run();
    await audit(ctx, { tool, outcome: 'ok', siteId });
    return result;
  } catch (error) {
    if (error instanceof ToolError) {
      await audit(ctx, {
        tool,
        outcome: error.code === 'forbidden' ? 'denied' : 'error',
        detail: error.code
      });
    } else {
      // Log the name and the message. The message is redacted by the logger, and
      // without it an unexpected failure is untraceable in production.
      logger.error('tool.unexpected', { tool, ...errorSummary(error) });
      await audit(ctx, { tool, outcome: 'error', detail: 'unexpected' });
    }
    throw error;
  }
}
