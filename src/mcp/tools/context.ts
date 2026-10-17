/**
 * Per-invocation tool context.
 *
 * Everything a tool is allowed to do is derived from the *verified* token, never
 * from tool arguments:
 *  - `userId` and `clientId` come from the validated access token.
 *  - `scopes` come from the token, and every tool re-checks its own scope.
 *  - The site lookup is scoped by `userId`, so a site id from another account is
 *    simply not found.
 *
 * Tool arguments can therefore only ever select *which of this account's own
 * sites* to act on, never widen access. That is the hosted trust model.
 *
 * Since the portable-core extraction, the three things a tool needs from outside
 * the process arrive through ports (`SiteSource`, `AuditSink`, `ProposalStore`)
 * rather than through a D1 handle. The Cloudflare transport supplies D1-backed
 * implementations, the local stdio transport supplies configuration- and
 * memory-backed ones, and the tools cannot tell the difference. See `ports.ts` for
 * why that is enough to share all nineteen tools.
 *
 * `requireToolScope` is deliberately still called by every tool even in a transport
 * that grants every scope. A check that is vacuous locally costs nothing and means
 * the same code is exercised in both places.
 */

import type { AuthProps, McpEnv } from '../../shared/env.js';
import { ToolError } from '../../shared/errors.js';
import { hasScopes, scopesForTool } from '../../shared/scopes.js';
import { urlPolicyFor } from '../../shared/policy.js';
import { errorSummary, logger } from '../../shared/log.js';
import type { UrlPolicy } from '../../shared/ssrf.js';
import { proposalTtlSeconds } from '../../proposals/store.js';
import { d1AuditSink, d1ProposalStore, d1SiteSource } from './d1-ports.js';
import type { AuditEntry, AuditSink, ProposalStore, ResolvedSite, SiteSource } from './ports.js';

export type { AuditEntry, AuditSink, ProposalStore, ResolvedSite, SiteSource };

export interface ToolContext {
  sites: SiteSource;
  proposals: ProposalStore;
  audit: AuditSink;
  userId: string;
  clientId: string;
  scopes: string[];
  props: AuthProps;
  policy: UrlPolicy;
  /** Present only in the hosted adapter; the local transport has no database. */
  db?: D1Database;
  env?: McpEnv;
}

/**
 * Build the context for the Cloudflare transport. Signature and behaviour are
 * unchanged from before the extraction, so `src/mcp/app.ts` did not have to move.
 */
export function buildToolContext(
  env: McpEnv,
  props: AuthProps,
  auth: { scope: string[]; clientId?: string }
): ToolContext {
  const clientId = auth.clientId ?? 'unknown';
  return {
    db: env.DB,
    env,
    sites: d1SiteSource(env, props.userId),
    proposals: d1ProposalStore(env.DB, props.userId, proposalTtlSeconds(env)),
    audit: d1AuditSink(env.DB, props.userId, clientId),
    userId: props.userId,
    clientId,
    scopes: auth.scope,
    props,
    policy: urlPolicyFor(env)
  };
}

/**
 * Enforce a tool's scope on the server. This runs inside the tool callback as well
 * as in the HTTP pre-flight, so a bug in the pre-flight cannot silently authorise a
 * write.
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

/** Resolve a site reference and build a client with freshly decrypted credentials. */
export async function resolveSite(ctx: ToolContext, reference: string): Promise<ResolvedSite> {
  return ctx.sites.resolve(reference);
}

/**
 * The site to act on when the caller did not name one.
 *
 * With exactly one connected site this is unambiguous. With several, guessing
 * would be dangerous, so the caller is asked to be explicit.
 */
export async function defaultSite(ctx: ToolContext): Promise<ResolvedSite> {
  return ctx.sites.default();
}

/** Resolve an explicit site, or fall back to the sole connected site. */
export async function siteFor(ctx: ToolContext, reference: string | undefined): Promise<ResolvedSite> {
  if (reference && reference.trim() !== '') return resolveSite(ctx, reference);
  return defaultSite(ctx);
}

export async function audit(ctx: ToolContext, options: AuditEntry): Promise<void> {
  await ctx.audit.record(options);
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
