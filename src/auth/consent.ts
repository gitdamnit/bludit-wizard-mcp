/**
 * Consent page and decision handling.
 *
 * The page is deliberately explicit about three facts the MCP authorization
 * spec requires a user to see: which client is asking, where the token will be
 * sent (including the redirect host), and which scopes are being requested.
 *
 * Everything rendered here can originate from the client, so every value goes
 * through `escapeHtml`.
 */

import type { AuthorizationError, AuthRequest, OAuthHelpers, ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { escapeHtml, htmlResponse, renderPage } from '../shared/html.js';
import { REQUIRED_SCOPES, SCOPES, filterGrantableScopes } from '../shared/scopes.js';
import type { AuthEnv } from '../shared/env.js';
import type { PublicUser } from './accounts.js';

export interface ConsentView {
  description: ConsentDescription;
  /** Scopes the user may approve; baseline read scopes are marked required. */
  requested: Array<{ scope: string; required: boolean; description: string }>;
  handle: string;
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'sites:read': 'List the Bludit websites connected to your account, and inspect what they support.',
  'pages:read': 'Read pages, drafts, tags and categories from your websites.',
  'pages:write': 'Create and change pages on your websites.',
  'settings:read': 'Read website settings such as site title, description and language.',
  offline_access: 'Stay connected so you do not have to sign in again each time (refresh token).'
};

export function buildConsentView(
  description: ConsentDescription,
  request: AuthRequest,
  handle: string
): ConsentView {
  const grantable = filterGrantableScopes(request.scope);
  const scopeList = grantable.length > 0 ? grantable : (['sites:read', 'pages:read'] as const);
  return {
    description,
    handle,
    requested: scopeList.map((scope) => ({
      scope,
      required: REQUIRED_SCOPES.includes(scope),
      description: SCOPE_DESCRIPTIONS[scope] ?? scope
    })),
    ...(request && {})
  } as ConsentView;
}

export async function renderConsentPage(
  oauth: OAuthHelpers,
  authRequest: AuthRequest,
  user: PublicUser,
  session: { csrfToken: string },
  extra: { error?: string } = {}
): Promise<Response> {
  const transaction = await oauth.beginConsent(authRequest);
  const description = await oauth.describeConsent(authRequest);
  const view = buildConsentView(description, authRequest, transaction.handle);

  const scopeItems = view.requested
    .map(
      (item) => `
      <li>
        <label style="font-weight:400;display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" name="scope" value="${escapeHtml(item.scope)}"
                 ${item.required ? 'checked disabled' : 'checked'} style="width:auto;margin-top:4px">
          <span><strong>${escapeHtml(item.scope)}</strong><br><span class="muted">${escapeHtml(item.description)}</span></span>
        </label>
        ${item.required ? `<input type="hidden" name="scope" value="${escapeHtml(item.scope)}">` : ''}
      </li>`
    )
    .join('');

  const originWarning = view.description.clientDomain
    ? `<p class="muted">Client domain (verified by its metadata document): <code>${escapeHtml(view.description.clientDomain)}</code></p>`
    : `<p class="notice">This client's name is self-declared and not verified. Confirm the redirect host below before allowing.</p>`;

  const loopbackWarning = view.description.redirectIsLoopback
    ? `<p class="error">This client returns the code to a local application (<code>${escapeHtml(view.description.redirectHost)}</code>). Any process on that machine could be listening.</p>`
    : '';

  const body = `
<h1>Authorize ${escapeHtml(view.description.clientName)}</h1>
<p class="muted">Signed in as ${escapeHtml(user.email)}</p>

${extra.error ? `<p class="error">${escapeHtml(extra.error)}</p>` : ''}

<div class="card">
  <table>
    <tr><th>Client</th><td>${escapeHtml(view.description.clientName)}<br><code class="muted">${escapeHtml(view.description.clientId)}</code></td></tr>
    ${view.description.clientUri ? `<tr><th>Homepage</th><td><code>${escapeHtml(view.description.clientUri)}</code></td></tr>` : ''}
    <tr><th>Sends the result to</th><td><strong>${escapeHtml(view.description.redirectHost)}</strong><br><code class="muted">${escapeHtml(view.description.redirectUri)}</code></td></tr>
  </table>
  ${originWarning}
  ${loopbackWarning}
</div>

<form method="post" action="/authorize/decision">
  <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
  <input type="hidden" name="handle" value="${escapeHtml(transaction.handle)}">

  <div class="card">
    <h2 style="margin-top:0">Permissions requested</h2>
    <ul class="scopes" style="list-style:none;padding-left:0">${scopeItems}</ul>
    <p class="muted">Uncheck a permission to grant less. The client will ask again if it later needs it.</p>
  </div>

  <div class="card">
    <label style="font-weight:400;display:flex;gap:8px;align-items:center">
      <input type="checkbox" name="remember" value="1" checked style="width:auto">
      Remember this decision for 30 days
    </label>
  </div>

  <div class="row">
    <button type="submit" name="decision" value="allow">Allow</button>
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  </div>
</form>

<p class="muted">You can disconnect this client at any time from the <a href="/sites">connected sites</a> page.</p>
`;

  return htmlResponse(renderPage({ title: `Authorize ${view.description.clientName}`, body }), 200, transaction.headers);
}

export interface DecisionResult {
  ok: true;
  redirectTo: string;
  headers: Headers;
}

/** Translate a posted decision into an approved or denied OAuth redirect. */
export async function handleDecision(
  oauth: OAuthHelpers,
  env: AuthEnv,
  request: Request,
  user: PublicUser,
  input: { handle: string; decision: string; scopes: string[]; remember: boolean }
): Promise<DecisionResult> {
  if (input.decision === 'deny') {
    const denied = await oauth.denyConsent(request, input.handle);
    return { ok: true, redirectTo: denied.redirectTo, headers: denied.headers };
  }

  const granted = filterGrantableScopes(input.scopes);
  if (granted.length === 0) {
    throw new ConsentInputError('Select at least one permission, or choose Deny.');
  }

  const approved = await oauth.approveConsent(request, input.handle, {
    scope: granted,
    ...(input.remember
      ? { remember: { secret: env.CONSENT_SECRET, maxAgeSeconds: 30 * 24 * 3600, subject: user.id } }
      : {})
  });

  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: user.id,
    scope: granted,
    metadata: {
      scopes: granted,
      consentedAt: Date.now(),
      consentedFrom: new URL(env.AUTH_ISSUER).host
    },
    // `props` is encrypted into the access token; the resource server reads it
    // as `ctx.props`. Only identity and the credential-key generation travel.
    props: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      credentialKeyVersion: Number.parseInt(env.CREDENTIAL_KEY_VERSION ?? '1', 10) || 1
    }
  });

  return { ok: true, redirectTo, headers: approved.headers };
}

export class ConsentInputError extends Error {}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'description' in error &&
    typeof (error as { description: unknown }).description === 'string'
  );
}

export const GRANTABLE_SCOPES = [...SCOPES];
