/**
 * Authorization server HTTP application.
 *
 * Responsibility split:
 *   - `/authorize` and `/authorize/decision` — the interactive consent flow,
 *     which this application owns.
 *   - Everything protocol-owned (`/.well-known/*`, `/oauth/token`, revocation,
 *     registration) is served by the OAuth library's `fetch`.
 *   - `/sites*`, `/clients*`, `/signin`, `/signup` — account and site management.
 *
 * A token is never issued without a signed-in account *and* an explicit consent
 * decision.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AuthorizationError, CimdFetchError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import { escapeHtml, htmlResponse, renderPage } from '../shared/html.js';
import { errorSummary, logger } from '../shared/log.js';
import { filterGrantableScopes, REQUIRED_SCOPES } from '../shared/scopes.js';
import { clientIp, enforceRateLimit } from '../shared/rate-limit.js';
import { clearCookie, parseCookies, serializeCookie, sessionCookieName } from '../shared/cookies.js';
import { safeNext } from '../shared/redirect.js';
import { authenticate, countUsers, createUser } from './accounts.js';
import {
  createSession,
  destroySession,
  resolveSession,
  verifyCsrf,
  SESSION_TTL_SECONDS,
  type SessionContext
} from './sessions.js';
import { createAuthorizationServer } from './oauth.js';
import { handleDecision, isAuthorizationError, renderConsentPage } from './consent.js';
import { registerSiteRoutes } from './sites-ui.js';
import { registerTokenRoutes } from './tokens-ui.js';
import type { AuthApp } from './types.js';
import type { AuthEnv } from '../shared/env.js';

export function createAuthApp(env: AuthEnv): AuthApp {
  const app = new Hono<{ Bindings: AuthEnv; Variables: { session: SessionContext } }>();

  // ----- session middleware ------------------------------------------------
  app.use('*', async (c, next) => {
    const cookies = parseCookies(c.req.header('cookie') ?? null);
    const token = cookies[sessionCookieName(c.env.AUTH_ISSUER)];
    const session = await resolveSession(c.env, c.req.raw, token);
    if (session) c.set('session', session);
    await next();
  });

  // ----- health ------------------------------------------------------------
  app.get('/healthz', async (c) => {
    let db: 'ok' | 'error' = 'ok';
    let detail = '';
    try {
      await c.env.DB.prepare('SELECT 1').first();
    } catch (error) {
      db = 'error';
      detail = errorSummary(error).name;
    }
    return c.json(
      { ok: db === 'ok', db, detail, issuer: c.env.AUTH_ISSUER, resource: c.env.MCP_RESOURCE },
      db === 'ok' ? 200 : 503
    );
  });

  // ----- landing -----------------------------------------------------------
  app.get('/', async (c) => {
    if (c.get('session')) return c.redirect('/sites', 302);
    return htmlResponse(
      renderPage({
        title: 'Bludit Wizard MCP',
        body: `
<h1>Bludit Wizard MCP</h1>
<p class="muted">Connect AI clients to Bludit websites you control.</p>
<div class="card">
  <p>This service lets MCP-compatible clients — ChatGPT, Claude, Codex, Gemini CLI, OpenCode and others —
  read and update pages on Bludit sites you connect to your account.</p>
  <p>It runs no model of its own, stores no page content, and never holds a Bludit credential in the clear.</p>
  <div class="row">
    <a href="/signin"><button>Sign in</button></a>
    <a href="/signup"><button class="secondary">Create an account</button></a>
  </div>
</div>
<p class="muted">MCP endpoint: <code>${escapeHtml(c.env.MCP_RESOURCE)}</code></p>
`
      })
    );
  });

  // ----- sign up -----------------------------------------------------------
  app.get('/signup', async (c) => {
    if (!(await signupOpen(c.env))) {
      return htmlResponse(
        shell('Sign up', '<h1>Sign up</h1><p class="muted">Account creation is disabled on this deployment.</p>'),
        403
      );
    }
    return renderAuthForm(c, 'Create an account', '/signup', true, undefined, {}, safeNext(c.req.query('next')));
  });

  app.post('/signup', async (c) => {
    if (!(await signupOpen(c.env))) {
      return htmlResponse(shell('Sign up', '<p class="error">Account creation is disabled.</p>'), 403);
    }

    // The most expensive unauthenticated endpoint on the service: PBKDF2 plus a
    // row. Bounded before the body is read.
    const limited = await enforceRateLimit(c.env.DB, c.env, 'signup', [clientIp(c.req.raw)], {
      format: 'json',
      message: 'Too many accounts have been created from this address. Please try again later.',
      secret: c.env.SESSION_SECRET
    });
    if (limited) return limited;

    const form = await readForm(c.req.raw);
    try {
      const user = await createUser(c.env, {
        email: form.email ?? '',
        password: form.password ?? '',
        displayName: form.displayName ?? ''
      });
      const session = await createSession(c.env, user.id, { userAgent: c.req.header('user-agent') });
      logger.info('auth.signup.ok', { userId: user.id });
      return sessionRedirect(c.env, session, safeNext(form.next) ?? '/sites');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create the account.';
      return renderAuthForm(c, 'Create an account', '/signup', true, message, form, safeNext(form.next));
    }
  });

  // ----- sign in -----------------------------------------------------------
  app.get('/signin', async (c) =>
    renderAuthForm(c, 'Sign in', '/signin', false, undefined, {}, safeNext(c.req.query('next')))
  );

  app.post('/signin', async (c) => {
    const form = await readForm(c.req.raw);

    // Brute-force protection, keyed by address *and* email so one account cannot
    // be ground down from many addresses, and one address cannot be used to
    // spray many accounts. The refusal is identical whether or not the account
    // exists, so it cannot be used to enumerate accounts.
    const limited = await enforceRateLimit(
      c.env.DB,
      c.env,
      'signin',
      [clientIp(c.req.raw), (form.email ?? '').trim().toLowerCase()],
      {
        format: 'json',
        message: 'Too many sign-in attempts. Please wait and try again.',
        secret: c.env.SESSION_SECRET
      }
    );
    if (limited) {
      logger.warn('auth.signin.rate_limited', {});
      return limited;
    }

    const user = await authenticate(c.env, form.email ?? '', form.password ?? '');
    if (!user) {
      logger.warn('auth.signin.failed', { emailDomain: (form.email ?? '').split('@')[1] ?? '' });
      return renderAuthForm(
        c,
        'Sign in',
        '/signin',
        false,
        'Email or password is incorrect.',
        form,
        safeNext(form.next)
      );
    }
    const session = await createSession(c.env, user.id, { userAgent: c.req.header('user-agent') });
    logger.info('auth.signin.ok', { userId: user.id });
    return sessionRedirect(c.env, session, safeNext(form.next) ?? '/sites');
  });

  app.get('/signout', async (c) => {
    const cookies = parseCookies(c.req.header('cookie') ?? null);
    await destroySession(c.env, cookies[sessionCookieName(c.env.AUTH_ISSUER)]);
    const secure = new URL(c.env.AUTH_ISSUER).protocol === 'https:';
    return new Response(null, {
      status: 303,
      headers: { location: '/', 'set-cookie': clearCookie(sessionCookieName(c.env.AUTH_ISSUER), secure) }
    });
  });

  // ----- consent -----------------------------------------------------------
  app.get('/authorize', async (c) => {
    // Bounds authorization-request floods before any client lookup happens.
    const limited = await enforceRateLimit(c.env.DB, c.env, 'authorize', [clientIp(c.req.raw)], {
      format: 'oauth',
      message: 'Too many authorization requests from this address. Please try again later.',
      secret: c.env.SESSION_SECRET
    });
    if (limited) return limited;

    const authorizationServer = createAuthorizationServer(c.env);
    const oauth = authorizationServer.getOAuthApi(c.env);

    let authRequest: AuthRequest;
    try {
      authRequest = await oauth.parseAuthRequest(c.req.raw);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        // `redirectTo` is set only once client and redirect URI are validated.
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return htmlResponse(shell('Authorization error', `<p class="error">${escapeHtml(error.description)}</p>`), 400);
      }
      if (error instanceof CimdFetchError) {
        logger.warn('oauth.cimd.failed', { reason: error.reason });
        return htmlResponse(
          shell(
            'Client metadata unavailable',
            '<p class="error">This client identifies itself with a metadata document that could not be resolved. Try again, or ask the client vendor to publish one.</p>'
          ),
          400
        );
      }
      throw error;
    }

    const session = c.get('session');
    if (!session) {
      const next = `/authorize${new URL(c.req.url).search}`;
      return c.redirect(`/signin?next=${encodeURIComponent(next)}`, 302);
    }

    const remembered = await oauth.isConsentRemembered(c.req.raw, authRequest, {
      secret: c.env.CONSENT_SECRET,
      subject: session.user.id
    });

    if (remembered) {
      const granted = filterGrantableScopes(authRequest.scope);
      const { redirectTo } = await oauth.completeAuthorization({
        request: authRequest,
        userId: session.user.id,
        scope: granted.length > 0 ? granted : [...REQUIRED_SCOPES],
        metadata: { remembered: true, at: Date.now() },
        props: propsFor(session, c.env)
      });
      return Response.redirect(redirectTo, 302);
    }

    try {
      return await renderConsentPage(oauth, authRequest, session.user, session);
    } catch (error) {
      if (isAuthorizationError(error)) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return htmlResponse(shell('Authorization error', `<p class="error">${escapeHtml(error.description)}</p>`), 400);
      }
      throw error;
    }
  });

  app.post('/authorize/decision', async (c) => {
    const session = c.get('session');
    if (!session) return c.redirect('/signin', 302);

    // Each acceptance writes a grant and an authorization code. Bounded per
    // account, before the body is read.
    const limited = await enforceRateLimit(c.env.DB, c.env, 'consent', [session.user.id], {
      format: 'json',
      message: 'Too many authorization decisions. Please wait and try again.',
      secret: c.env.SESSION_SECRET
    });
    if (limited) return limited;

    // The body can only be read once, so read it once and pull everything out.
    const formData = await c.req.formData();
    const single = (key: string): string => {
      const value = formData.get(key);
      return typeof value === 'string' ? value : '';
    };
    const scopes = formData.getAll('scope').filter((value): value is string => typeof value === 'string');

    if (!(await verifyCsrf(c.env, session, single('csrf')))) {
      return htmlResponse(shell('Invalid request', '<p class="error">Invalid CSRF token. Start the authorization again.</p>'), 403);
    }

    const authorizationServer = createAuthorizationServer(c.env);
    const oauth = authorizationServer.getOAuthApi(c.env);

    try {
      const result = await handleDecision(oauth, c.env, c.req.raw, session.user, {
        handle: single('handle'),
        decision: single('decision'),
        scopes,
        remember: single('remember') === '1'
      });
      // Mutate the returned Headers rather than copying them: constructing a new
      // Headers from an existing one is not guaranteed to carry `Set-Cookie`
      // through, and the remembered-consent cookie lives in these headers.
      result.headers.set('location', result.redirectTo);
      logger.info('oauth.consent.completed', { userId: session.user.id, scopes: scopes.join(' ') });
      return new Response(null, { status: 303, headers: result.headers });
    } catch (error) {
      if (isAuthorizationError(error)) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return htmlResponse(shell('Authorization error', `<p class="error">${escapeHtml(error.description)}</p>`), 400);
      }
      const message = error instanceof Error ? error.message : 'The authorization request could not be completed.';
      return htmlResponse(shell('Authorization error', `<p class="error">${escapeHtml(message)}</p>`), 400);
    }
  });

  // ----- connected OAuth clients ------------------------------------------
  app.get('/clients', async (c) => {
    const session = c.get('session');
    if (!session) return c.redirect('/signin', 302);

    const authorizationServer = createAuthorizationServer(c.env);
    const oauth = authorizationServer.getOAuthApi(c.env);
    const grants = await oauth.listUserGrants(session.user.id, { limit: 100 });

    const rows = grants.items.length
      ? grants.items
          .map(
            (grant) => `
      <tr>
        <td><code>${escapeHtml(truncate(grant.clientId, 60))}</code></td>
        <td><code>${escapeHtml(grant.scope.join(' '))}</code></td>
        <td class="muted">${escapeHtml(new Date(grant.createdAt).toISOString().slice(0, 10))}</td>
        <td>
          <form method="post" action="/clients/${escapeHtml(grant.id)}/revoke">
            <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
            <button class="danger" type="submit">Revoke</button>
          </form>
        </td>
      </tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted">No clients have been authorized yet.</td></tr>';

    return htmlResponse(
      shell(
        'Connected clients',
        `
<h1>Connected MCP clients</h1>
<p class="muted">Every client is authorized separately. Revoking one does not affect the others.</p>
${c.req.query('revoked') ? '<p class="notice">Client revoked. Its tokens stop working immediately.</p>' : ''}
<div class="card"><table>
  <tr><th>Client</th><th>Scopes</th><th>Authorized</th><th></th></tr>
  ${rows}
</table></div>
<p class="muted"><a href="/sites">Back to connected sites</a></p>
`
      )
    );
  });

  app.post('/clients/:id/revoke', async (c) => {
    const session = c.get('session');
    if (!session) return c.redirect('/signin', 302);
    const form = await readForm(c.req.raw);
    if (!(await verifyCsrf(c.env, session, form.csrf ?? ''))) {
      return htmlResponse(shell('Invalid request', '<p class="error">Invalid CSRF token.</p>'), 403);
    }
    const authorizationServer = createAuthorizationServer(c.env);
    const oauth = authorizationServer.getOAuthApi(c.env);
    await oauth.revokeGrant(c.req.param('id'), session.user.id);
    logger.info('oauth.grant.revoked', { userId: session.user.id });
    return c.redirect('/clients?revoked=1', 303);
  });

  registerSiteRoutes(app);
  registerTokenRoutes(app);

  return app;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function propsFor(session: SessionContext, env: AuthEnv): Record<string, unknown> {
  return {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    credentialKeyVersion: Number.parseInt(env.CREDENTIAL_KEY_VERSION ?? '1', 10) || 1
  };
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function signupOpen(env: AuthEnv): Promise<boolean> {
  if (env.ALLOW_SIGNUP !== 'false') return true;
  return (await countUsers(env)) === 0;
}

function sessionRedirect(
  env: AuthEnv,
  session: { token: string; cookieName: string },
  location: string
): Response {
  const secure = new URL(env.AUTH_ISSUER).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'set-cookie': serializeCookie(session.cookieName, session.token, {
        maxAgeSeconds: SESSION_TTL_SECONDS,
        secure
      })
    }
  });
}

function shell(title: string, body: string): string {
  return renderPage({ title, body });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function renderAuthForm(
  c: Context,
  title: string,
  action: string,
  withDisplayName: boolean,
  error?: string,
  values: Record<string, string> = {},
  next?: string | null
): Response {
  const body = `
<h1>${escapeHtml(title)}</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}">
  ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}
  ${
    withDisplayName
      ? `<label for="displayName">Name</label>
         <input id="displayName" name="displayName" value="${escapeHtml(values.displayName ?? '')}" maxlength="120">`
      : ''
  }
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(values.email ?? '')}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="${withDisplayName ? 'new-password' : 'current-password'}" required>
  ${withDisplayName ? '<p class="muted">At least 12 characters.</p>' : ''}
  <p style="margin-top:16px"><button type="submit">${escapeHtml(title)}</button></p>
</form>
<p class="muted">${
    withDisplayName
      ? 'Already have an account? <a href="/signin">Sign in</a>.'
      : 'No account yet? <a href="/signup">Create one</a>.'
  }</p>
`;
  return htmlResponse(shell(title, body));
}
