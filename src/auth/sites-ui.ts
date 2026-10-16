/**
 * Site management UI for the authorization server.
 *
 * This is the only place a Bludit credential is ever entered. It is a
 * server-rendered form: no client-side JavaScript beyond a confirm() dialog, no
 * CORS surface, and every mutating request carries the account session's CSRF
 * token.
 */

import { escapeHtml, htmlResponse, renderPage } from '../shared/html.js';
import { ToolError, isToolError } from '../shared/errors.js';
import { urlPolicyFor } from '../shared/policy.js';
import { detectCapabilities } from '../bludit/capabilities.js';
import { BluditClient } from '../bludit/client.js';
import type { BluditEdition } from '../bludit/capability-types.js';
import { createPairingChallenge, WELL_KNOWN_CHALLENGE_PATH } from '../sites/pairing.js';
import { connectSite } from '../sites/connect.js';
import { resolveSiteRow, toPublicSite, type SiteRow } from '../sites/registry.js';
import { toBluditCredentials } from '../sites/credentials.js';
import { verifyCsrf } from './sessions.js';
import type { AuthApp, AuthContext } from './types.js';

export function registerSiteRoutes(app: AuthApp): void {
  /**
   * Every site route requires a signed-in account. Without this guard an
   * unauthenticated request reached the handler and failed on `session.user`,
   * returning a 500 instead of sending the visitor to sign in.
   */
  app.use('/sites', requireSession);
  app.use('/sites/*', requireSession);

  app.get('/sites', async (c) => renderSitesPage(c));

  app.post('/sites/challenge', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) {
      return forbidden();
    }
    const created = await createPairingChallenge(c.env.DB, c.env.SESSION_SECRET, session.user.id, {
      label: form.label ?? '',
      baseUrl: (form.baseUrl ?? '').trim()
    });
    return renderConnectForm(c, {
      challenge: created.challenge,
      baseUrl: (form.baseUrl ?? '').trim(),
      label: form.label ?? '',
      edition: 'unknown'
    });
  });

  app.post('/sites/connect', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) {
      return forbidden();
    }

    const edition = parseEdition(form.edition);

    try {
      const result = await connectSite(
        { db: c.env.DB, env: c.env, policy: urlPolicyFor(c.env) },
        {
          userId: session.user.id,
          challenge: form.challenge ?? '',
          baseUrl: form.baseUrl ?? '',
          label: form.label ?? '',
          declaredEdition: edition,
          credentials: {
            apiToken: form.apiToken ?? '',
            authToken: form.authToken ?? '',
            wizardApiKey: form.wizardApiKey ?? '',
            wizardApiBase: form.wizardApiBase ?? ''
          }
        }
      );
      return c.redirect(`/sites?connected=${encodeURIComponent(result.siteId)}`, 303);
    } catch (error) {
      const message = isToolError(error) ? error.message : 'The site could not be connected.';
      const details = isToolError(error) ? (error.details as Record<string, unknown>) : {};
      return renderConnectForm(c, {
        challenge: form.challenge ?? '',
        baseUrl: form.baseUrl ?? '',
        label: form.label ?? '',
        edition,
        error: message,
        details
      });
    }
  });

  app.post('/sites/:id/delete', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) {
      return forbidden();
    }
    await c.env.DB.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), session.user.id)
      .run();
    return c.redirect('/sites?removed=1', 303);
  });

  app.post('/sites/:id/check', async (c) => {
    const session = c.get('session');
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) {
      return forbidden();
    }

    try {
      const row = await resolveSiteRow(c.env.DB, session.user.id, c.req.param('id'));
      const credentials = await toBluditCredentials(c.env, row.id, row.base_url, row);
      const client = new BluditClient(credentials, { policy: urlPolicyFor(c.env) });
      const capabilities = await detectCapabilities(client, { declaredEdition: parseEdition(row.edition) });
      const healthy = capabilities.bluditApi.readOk || capabilities.bluditApi.authenticatedOk;
      await c.env.DB.prepare(
        `UPDATE sites SET capabilities_json = ?, last_checked_at = ?, updated_at = ?, status = ?, last_error = ?
         WHERE id = ? AND user_id = ?`
      )
        .bind(
          JSON.stringify(capabilities),
          capabilities.checkedAt,
          Date.now(),
          healthy ? 'connected' : 'error',
          capabilities.bluditApi.readOk ? '' : capabilities.bluditApi.readError,
          row.id,
          session.user.id
        )
        .run();
    } catch (error) {
      if (error instanceof ToolError) {
        await c.env.DB.prepare('UPDATE sites SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .bind('error', error.message.slice(0, 500), Date.now(), c.req.param('id'), session.user.id)
          .run();
      }
    }
    return c.redirect('/sites?checked=1', 303);
  });
}

// ---------------------------------------------------------------------------

/**
 * Send an unauthenticated visitor to sign in, remembering where they were going.
 * Applies to every `/sites` route, including the mutating ones.
 */
async function requireSession(c: AuthContext, next: () => Promise<void>): Promise<Response | void> {
  if (!c.get('session')) {
    const url = new URL(c.req.url);
    return c.redirect(`/signin?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  }
  await next();
}

function forbidden(): Response {
  return htmlResponse(renderPage({ title: 'Invalid request', body: '<p class="error">Invalid CSRF token. Reload and try again.</p>' }), 403);
}

function parseEdition(value: string | undefined): BluditEdition {
  return value === 'community' || value === 'pro' ? value : 'unknown';
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function shell(title: string, body: string): string {
  return renderPage({ title, body });
}

async function renderSitesPage(c: AuthContext): Promise<Response> {
  const session = c.get('session');
  const rows = await c.env.DB.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY label COLLATE NOCASE')
    .bind(session.user.id)
    .all<SiteRow>();
  const sites = (rows.results ?? []).map((row) => toPublicSite(row, true));

  const banner = c.req.query('connected')
    ? '<p class="notice">Site connected. It is now available to your authorized MCP clients.</p>'
    : c.req.query('checked')
      ? '<p class="notice">Capabilities refreshed.</p>'
      : c.req.query('removed')
        ? '<p class="notice">Site removed.</p>'
        : '';

  const siteCards = sites.length === 0
    ? '<p class="muted">No sites connected yet.</p>'
    : sites
        .map((site) => {
          const api = site.capabilities?.bluditApi;
          const badge = site.status === 'connected' ? '✅' : '⚠️';
          return `
          <div class="card">
            <div class="row" style="justify-content:space-between">
              <div>
                <strong>${escapeHtml(site.label)}</strong> ${badge}
                <div class="muted"><code>${escapeHtml(site.baseUrl)}</code></div>
              </div>
              <div class="row">
                <form method="post" action="/sites/${escapeHtml(site.id)}/check">
                  <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                  <button class="secondary" type="submit">Refresh</button>
                </form>
                <form method="post" action="/sites/${escapeHtml(site.id)}/delete"
                      onsubmit="return confirm('Remove this site? MCP clients lose access immediately.')">
                  <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                  <button class="danger" type="submit">Remove</button>
                </form>
              </div>
            </div>
            <table>
              <tr><th>Edition declared</th><td>${escapeHtml(site.edition)}</td></tr>
              <tr><th>Bludit API reads</th><td>${sitesReadState(api)}</td></tr>
              <tr><th>Authenticated (write) access</th><td>${api ? (api.authenticatedOk ? 'working' : 'not working') : 'not checked'}</td></tr>
              <tr><th>Wizard extension</th><td>${site.wizardExtension ? 'detected' : 'not detected'}</td></tr>
              ${site.lastError ? `<tr><th>Last error</th><td class="error">${escapeHtml(site.lastError)}</td></tr>` : ''}
            </table>
          </div>`;
        })
        .join('');

  const body = `
<h1>Connected sites</h1>
<p class="muted">Signed in as ${escapeHtml(session.user.email)}</p>
${banner}
${siteCards}

<div class="card">
  <h2 style="margin-top:0">Connect a Bludit site</h2>
  <p>Connecting proves you control the site — not merely that you know its URL and API token.</p>
  <form method="post" action="/sites/challenge">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
    <label for="label">Label</label>
    <input id="label" name="label" placeholder="My blog" maxlength="120">
    <label for="baseUrl">Site URL (optional — locks the challenge to one site)</label>
    <input id="baseUrl" name="baseUrl" placeholder="https://www.example.com" inputmode="url">
    <p style="margin-top:14px"><button type="submit">Generate pairing challenge</button></p>
  </form>
</div>

<p class="muted"><a href="/clients">Manage connected MCP clients</a> · <a href="/signout">Sign out</a></p>
`;
  return htmlResponse(shell('Connected sites', body));
}

function sitesReadState(api: { readOk: boolean; readError: string } | undefined): string {
  if (!api) return 'not checked';
  return api.readOk ? 'working' : `failing — ${escapeHtml(api.readError)}`;
}

interface ConnectFormState {
  challenge: string;
  baseUrl: string;
  label: string;
  edition: string;
  error?: string;
  details?: Record<string, unknown>;
}

async function renderConnectForm(c: AuthContext, state: ConnectFormState): Promise<Response> {
  const session = c.get('session');
  const wellKnown = `${state.baseUrl.replace(/\/+$/, '')}${WELL_KNOWN_CHALLENGE_PATH}`;

  const errorBlock = state.error
    ? `<div class="card">
         <p class="error">${escapeHtml(state.error)}</p>
         ${
           state.details && Object.keys(state.details).length > 0
             ? `<pre class="muted" style="white-space:pre-wrap">${escapeHtml(JSON.stringify(state.details, null, 2))}</pre>`
             : ''
         }
       </div>`
    : '';

  const body = `
<h1>Finish connecting ${escapeHtml(state.label || 'your site')}</h1>
${errorBlock}

<div class="card">
  <h2 style="margin-top:0">1. Pairing challenge</h2>
  <p>Shown once. The site must prove it received this exact value.</p>
  <code class="token">${escapeHtml(state.challenge)}</code>
  <p class="muted">Reloading this page invalidates nothing, but a fresh challenge is safer if you have shared the value.</p>
</div>

<div class="card">
  <h2 style="margin-top:0">2. Let the site prove it received the challenge</h2>
  <p><strong>Option A — Bludit Wizard extension (recommended).</strong> Install the Wizard plugin and set its
  <em>GPT Action API key</em>. The extension answers <code>/api/wizard/pair</code> with an HMAC proof computed
  from that key. Enter the same key below.</p>
  <p><strong>Option B — ownership file.</strong> Publish the challenge, and nothing else, at:</p>
  <code class="token">${escapeHtml(wellKnown || 'https://your-site.example/.well-known/bludit-wizard-challenge.txt')}</code>
</div>

<div class="card">
  <h2 style="margin-top:0">3. Site details</h2>
  <form method="post" action="/sites/connect">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
    <input type="hidden" name="challenge" value="${escapeHtml(state.challenge)}">

    <label for="baseUrl">Site URL</label>
    <input id="baseUrl" name="baseUrl" value="${escapeHtml(state.baseUrl)}" placeholder="https://www.example.com" required inputmode="url">

    <label for="label">Label</label>
    <input id="label" name="label" value="${escapeHtml(state.label)}" maxlength="120" placeholder="My blog">

    <label for="edition">Bludit edition (your declaration — Bludit does not report this over HTTP)</label>
    <select id="edition" name="edition">
      <option value="unknown"${state.edition === 'unknown' ? ' selected' : ''}>Not sure</option>
      <option value="community"${state.edition === 'community' ? ' selected' : ''}>Community (free)</option>
      <option value="pro"${state.edition === 'pro' ? ' selected' : ''}>Pro</option>
    </select>

    <label for="apiToken">Bludit API token (Admin → Plugins → API → Settings)</label>
    <input id="apiToken" name="apiToken" type="password" autocomplete="off" required>

    <label for="authToken">Bludit user auth token (Admin → Users → your user → Security → Token)</label>
    <input id="authToken" name="authToken" type="password" autocomplete="off">
    <p class="muted">Needed for writes and for reading site settings.</p>

    <label for="wizardApiKey">Bludit Wizard GPT Action API key (optional; enables Option A)</label>
    <input id="wizardApiKey" name="wizardApiKey" type="password" autocomplete="off">

    <label for="wizardApiBase">Wizard API base (optional)</label>
    <input id="wizardApiBase" name="wizardApiBase" placeholder="https://www.example.com/api/wizard" inputmode="url">

    <p style="margin-top:16px"><button type="submit">Connect site</button></p>
  </form>
</div>

<p class="muted"><a href="/sites">Back to connected sites</a></p>
`;
  return htmlResponse(shell('Connect a site', body));
}
