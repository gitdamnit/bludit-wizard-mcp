/**
 * Personal access token management UI.
 *
 * A token is created, shown exactly once, and revoked from here. This is the
 * only place a token ever exists in plaintext, and it is never written to a log,
 * a response after creation, or the database.
 */

import { escapeHtml, htmlResponse, renderPage } from '../shared/html.js';
import { filterGrantableScopes, NON_ACCESS_SCOPES, SCOPES } from '../shared/scopes.js';
import {
  DEFAULT_PAT_TTL_SECONDS,
  listPats,
  mintPat,
  revokePat,
  toPatSummary,
  PAT_PREFIX
} from '../shared/pats.js';
import { isToolError } from '../shared/errors.js';
import { verifyCsrf } from './sessions.js';
import type { AuthApp, AuthContext } from './types.js';

const SCOPE_HELP: Record<string, string> = {
  'sites:read': 'List the Bludit websites connected to your account, and see what they support.',
  'pages:read': 'Read pages, drafts, tags and categories.',
  'pages:write': 'Create and change pages, and propose and apply reviewed edits.',
  'settings:read': 'Read website settings such as site title, description and language.',
  offline_access: 'Not used by a token; tokens do not expire by being idle, only by their own expiry.'
};

export function registerTokenRoutes(app: AuthApp): void {
  app.use('/tokens', requireSession);
  app.use('/tokens/*', requireSession);

  app.get('/tokens', async (c) => renderTokens(c, { created: c.req.query('created') }));

  app.post('/tokens', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) return forbidden();

    const requested = form.getAll?.('scope') ?? [...SCOPES].filter((scope) => form[`scope_${scope}`] === '1');
    const ttlDays = Number.parseInt(form.ttlDays ?? '', 10);
    const ttlSeconds = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 : DEFAULT_PAT_TTL_SECONDS;

    try {
      const minted = await mintPat(c.env.DB, {
        userId: session.user.id,
        label: form.label ?? '',
        scopes: requested,
        ttlSeconds
      });
      // The token appears in this one response and nowhere else.
      return renderTokens(c, { created: minted.token, scopes: minted.scopes });
    } catch (error) {
      const message = isToolError(error) ? error.message : 'The token could not be created.';
      return renderTokens(c, { error: message });
    }
  });

  app.post('/tokens/:id/revoke', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) return forbidden();
    await revokePat(c.env.DB, session.user.id, c.req.param('id'));
    return c.redirect('/tokens?revoked=1', 303);
  });
}

// ---------------------------------------------------------------------------

async function requireSession(c: AuthContext, next: () => Promise<void>): Promise<Response | void> {
  if (!c.get('session')) return c.redirect('/signin?next=%2Ftokens', 302);
  await next();
}

function forbidden(): Response {
  return htmlResponse(renderPage({ title: 'Invalid request', body: '<p class="error">Invalid CSRF token.</p>' }), 403);
}

async function readForm(request: Request): Promise<Record<string, string> & { getAll?: (name: string) => string[] }> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.assign(out, { getAll: (name: string) => form.getAll(name).filter((v): v is string => typeof v === 'string') });
}

interface TokenPageState {
  created?: string;
  scopes?: string[];
  error?: string;
}

async function renderTokens(c: AuthContext, state: TokenPageState): Promise<Response> {
  const session = c.get('session');
  const rows = await listPats(c.env.DB, session.user.id);
  const tokens = rows.map((row) => toPatSummary(row));

  const createBlock = state.created
    ? `<div class="card">
         <h2 style="margin-top:0">Token created</h2>
         <p class="notice">Copy it now. It is not stored and cannot be shown again.</p>
         <code class="token">${escapeHtml(state.created)}</code>
         <p class="muted">Scopes: <code>${escapeHtml((state.scopes ?? []).join(' '))}</code></p>
         <p class="muted">Send it as <code>Authorization: Bearer ${escapeHtml(PAT_PREFIX)}…</code></p>
       </div>`
    : '';

  const listBlock = tokens.length
    ? tokens
        .map(
          (token) => `
      <tr>
        <td>${escapeHtml(token.label)}<br><code class="muted">${escapeHtml(token.id)}</code></td>
        <td><code>${escapeHtml(token.scopes.join(' '))}</code></td>
        <td class="muted">${escapeHtml(token.expiresAt.slice(0, 10))}${
          token.expired ? ' <span class="error">expired</span>' : ''
        }</td>
        <td class="muted">${token.lastUsedAt ? escapeHtml(token.lastUsedAt.slice(0, 10)) : 'never'}</td>
        <td>
          ${
            token.revoked
              ? '<span class="muted">revoked</span>'
              : `<form method="post" action="/tokens/${escapeHtml(token.id)}/revoke">
                   <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                   <button class="danger" type="submit">Revoke</button>
                 </form>`
          }
        </td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No tokens yet.</td></tr>';

  const scopeInputs = [...SCOPES]
    .filter((scope) => !NON_ACCESS_SCOPES.includes(scope))
    .map(
      (scope) => `
      <label style="font-weight:400;display:flex;gap:8px;align-items:flex-start;margin:8px 0">
        <input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked style="width:auto;margin-top:4px">
        <span><strong>${escapeHtml(scope)}</strong><br><span class="muted">${escapeHtml(SCOPE_HELP[scope] ?? scope)}</span></span>
      </label>`
    )
    .join('');

  const body = `
<h1>Personal access tokens</h1>
<p class="muted">Signed in as ${escapeHtml(session.user.email)}</p>

<div class="card">
  <p>Some clients cannot complete an OAuth sign-in and can only send a fixed
  <code>Authorization</code> header. A token is how you connect them.</p>
  <p class="muted">A token grants only the scopes you choose, expires on the date you choose, and can be
  revoked here at any time. It never grants page deletion, because no tool does. Treat it like a password:
  anyone who has it can use your sites until you revoke it.</p>
</div>

${state.error ? `<div class="card"><p class="error">${escapeHtml(state.error)}</p></div>` : ''}
${createBlock}

<div class="card">
  <h2 style="margin-top:0">Create a token</h2>
  <form method="post" action="/tokens">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
    <label for="label">Label</label>
    <input id="label" name="label" placeholder="GitHub Copilot cloud agent" maxlength="120" required>
    <label for="ttlDays">Expires in (days)</label>
    <input id="ttlDays" name="ttlDays" type="number" min="1" max="365" value="${DEFAULT_PAT_TTL_SECONDS / 86400}">
    <h2>Scopes</h2>
    ${scopeInputs}
    <p style="margin-top:16px"><button type="submit">Create token</button></p>
  </form>
</div>

<div class="card">
  <h2 style="margin-top:0">Existing tokens</h2>
  <table>
    <tr><th>Label</th><th>Scopes</th><th>Expires</th><th>Last used</th><th></th></tr>
    ${listBlock}
  </table>
</div>

<p class="muted"><a href="/sites">Connected sites</a> · <a href="/clients">Authorized clients</a> · <a href="/signout">Sign out</a></p>
`;
  return htmlResponse(renderPage({ title: 'Personal access tokens', body }));
}

export { filterGrantableScopes };
