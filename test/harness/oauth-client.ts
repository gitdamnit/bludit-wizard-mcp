/**
 * A minimal, standards-following MCP/OAuth client used by the integration tests.
 *
 * It performs the same sequence a real client does — discovery from the `401`
 * challenge, registration, PKCE authorization, consent, code exchange — rather
 * than reaching into the server's internals. If this helper has to be changed to
 * make a test pass, the protocol surface changed.
 */

import type { WorkerHandle } from 'wrangler';
import { AUTH_ORIGIN, CookieJar, MCP_ORIGIN, MCP_RESOURCE } from './index.js';
import type { AnyResponse } from './response.js';

export interface DiscoveredServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported: string[];
  revocation_endpoint?: string;
}

export interface ClientCredentials {
  clientId: string;
  redirectUri: string;
  /** Public clients have no secret. */
  clientSecret?: string;
}

export interface TokenSet {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface Account {
  email: string;
  password: string;
  jar: CookieJar;
}

/** Discover the authorization server from the MCP server's 401 challenge. */
export async function discover(mcp: WorkerHandle, auth: WorkerHandle): Promise<DiscoveredServer> {
  const challenge = await mcp.fetch(MCP_RESOURCE);
  if (challenge.status !== 401) {
    throw new Error(`Expected 401 from the MCP resource, got ${challenge.status}`);
  }
  const header = challenge.headers.get('www-authenticate') ?? '';
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  if (!metadataUrl) throw new Error(`No resource_metadata in challenge: ${header}`);

  const metadataResponse = await mcp.fetch(metadataUrl);
  const metadata = (await metadataResponse.json()) as { authorization_servers?: string[] };
  const issuer = metadata.authorization_servers?.[0];
  if (!issuer) throw new Error('No authorization server advertised');

  // The advertised issuer is the production hostname. Route its paths at the
  // local test auth Worker, keeping the path the server advertised.
  const path = new URL(`${issuer}/.well-known/oauth-authorization-server`).pathname;
  const response = await auth.fetch(new URL(path, AUTH_ORIGIN).toString());
  if (response.status !== 200) {
    throw new Error(`Authorization server metadata failed: ${response.status} ${await response.text()}`);
  }
  const as = (await response.json()) as DiscoveredServer;

  return {
    ...as,
    authorization_endpoint: rewriteToAuthOrigin(as.authorization_endpoint),
    token_endpoint: rewriteToAuthOrigin(as.token_endpoint),
    registration_endpoint: as.registration_endpoint ? rewriteToAuthOrigin(as.registration_endpoint) : undefined,
    revocation_endpoint: as.revocation_endpoint ? rewriteToAuthOrigin(as.revocation_endpoint) : undefined
  };
}

function rewriteToAuthOrigin(url: string): string {
  const parsed = new URL(url);
  return new URL(`${parsed.pathname}${parsed.search}`, AUTH_ORIGIN).toString();
}

/** Dynamic Client Registration (RFC 7591), as a public PKCE client. */
export async function registerClient(
  auth: WorkerHandle,
  as: DiscoveredServer,
  redirectUri = 'http://127.0.0.1:7654/callback'
): Promise<ClientCredentials> {
  if (!as.registration_endpoint) throw new Error('No registration endpoint advertised');
  const response = await auth.fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: 'Integration test client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { client_id: string; client_secret?: string };
  return { clientId: body.client_id, clientSecret: body.client_secret, redirectUri };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function createPkce(): Promise<PkcePair> {
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = Buffer.from(new Uint8Array(digest)).toString('base64url');
  return { verifier, challenge };
}

/** Sign up and keep the session cookie, so consent can be posted. */
export async function createAccount(
  auth: WorkerHandle,
  email: string,
  password = 'a-long-enough-password'
): Promise<Account> {
  const jar = new CookieJar();
  const response = await auth.fetch(`${AUTH_ORIGIN}/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password, displayName: 'Test User' }).toString(),
    redirect: 'manual'
  });
  jar.absorb(response);
  if (response.status !== 303) {
    throw new Error(`Signup failed: ${response.status} ${await response.text()}`);
  }
  return { email, password, jar };
}

export interface AuthorizeOptions {
  as: DiscoveredServer;
  client: ClientCredentials;
  scope: string;
  state?: string;
  /** Skip the consent page by remembering the decision. */
  remember?: boolean;
  /** Uncheck scopes in the consent form. */
  dropScopes?: string[];
}

export interface AuthorizeResult {
  code: string;
  state: string;
  /** The PKCE verifier used for this request, needed at the token endpoint. */
  verifier: string;
  redirectTo: string;
}

function hiddenField(html: string, name: string): string {
  const pattern = new RegExp(`name="${name}"\\s+value="([^"]*)"`);
  const match = pattern.exec(html);
  if (!match) throw new Error(`Consent page did not contain a ${name} field`);
  return match[1] as string;
}

/**
 * Walk /authorize to an authorization code.
 *
 * Handles both outcomes a real client sees: a consent page to approve, and a
 * bare redirect when the user has already approved this client for these scopes
 * and the decision was remembered.
 */
export async function authorize(
  auth: WorkerHandle,
  account: Account,
  options: AuthorizeOptions
): Promise<AuthorizeResult> {
  const state = options.state ?? `state-${crypto.randomUUID()}`;
  const pkce = await createPkce();
  const url = new URL(options.as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: options.client.clientId,
    redirect_uri: options.client.redirectUri,
    scope: options.scope,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    resource: MCP_RESOURCE
  })) {
    url.searchParams.set(key, value);
  }

  const response = await auth.fetch(url.toString(), {
    headers: { cookie: account.jar.header() },
    redirect: 'manual'
  });
  account.jar.absorb(response);

  if (response.status === 302 || response.status === 303) {
    const location = response.headers.get('location') ?? '';
    const redirect = new URL(location, options.client.redirectUri);
    const code = redirect.searchParams.get('code');
    if (!code) throw new Error(`Authorization failed: ${redirect.searchParams.get('error') ?? location}`);
    return { code, state: redirect.searchParams.get('state') ?? state, verifier: pkce.verifier, redirectTo: location };
  }

  if (response.status !== 200) {
    throw new Error(`Consent page failed: ${response.status} ${await response.text()}`);
  }
  const html = await response.text();

  const form = new URLSearchParams();
  form.set('csrf', hiddenField(html, 'csrf'));
  form.set('handle', hiddenField(html, 'handle'));
  form.set('decision', 'allow');
  if (options.remember === true) form.set('remember', '1');
  const requested = [...new Set([...html.matchAll(/name="scope" value="([^"]+)"/g)].map((m) => m[1] as string))];
  for (const scope of requested.filter((item) => !(options.dropScopes ?? []).includes(item))) {
    form.append('scope', scope);
  }

  const decision = await auth.fetch(`${AUTH_ORIGIN}/authorize/decision`, {
    method: 'POST',
    headers: { cookie: account.jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual'
  });
  account.jar.absorb(decision);
  const location = decision.headers.get('location');
  if (!location) {
    throw new Error(`Consent decision produced no redirect: ${decision.status} ${await decision.text()}`);
  }
  const redirect = new URL(location, options.client.redirectUri);
  const code = redirect.searchParams.get('code');
  if (!code) throw new Error(`Authorization failed: ${redirect.searchParams.get('error') ?? location}`);
  return { code, state: redirect.searchParams.get('state') ?? state, verifier: pkce.verifier, redirectTo: location };
}

export async function exchangeCode(
  auth: WorkerHandle,
  as: DiscoveredServer,
  client: ClientCredentials,
  code: string,
  verifier?: string
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    resource: MCP_RESOURCE
  });
  if (verifier) body.set('code_verifier', verifier);
  const response = await auth.fetch(as.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (response.status !== 200) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as TokenSet;
}

/** Full authorization-code + PKCE flow with consent, returning an access token. */
export async function accessToken(
  auth: WorkerHandle,
  account: Account,
  options: AuthorizeOptions
): Promise<TokenSet & { clientId: string }> {
  const result = await authorize(auth, account, options);
  const tokens = await exchangeCode(auth, options.as, options.client, result.code, result.verifier);
  return { ...tokens, clientId: options.client.clientId };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream'
};

export async function mcpCall(
  mcp: WorkerHandle,
  token: string | null,
  body: Record<string, unknown>
): Promise<{ status: number; response: AnyResponse; body?: JsonRpcResponse }> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await mcp.fetch(MCP_RESOURCE, { method: 'POST', headers, body: JSON.stringify(body) });
  let parsed: JsonRpcResponse | undefined;
  const text = await response.text();
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
      parsed = undefined;
    }
  }
  return { status: response.status, response, body: parsed };
}

export async function initialize(mcp: WorkerHandle, token: string): Promise<JsonRpcResponse | undefined> {
  const { body } = await mcpCall(mcp, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' }
    }
  });
  return body;
}

export async function listTools(mcp: WorkerHandle, token: string): Promise<Array<{ name: string; description?: string }>> {
  const { body } = await mcpCall(mcp, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const result = body?.result as { tools?: Array<{ name: string }> } | undefined;
  return result?.tools ?? [];
}

export interface ToolCallResult {
  status: number;
  isError: boolean;
  /** Parsed JSON payload the tool returned as text. */
  data: Record<string, unknown> | null;
  /** Raw JSON-RPC envelope, for protocol-level assertions. */
  envelope?: JsonRpcResponse;
  /** Raw text, for debugging failures. */
  raw: string;
  challenge?: string;
}

export async function callTool(
  mcp: WorkerHandle,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  const { status, response, body } = await mcpCall(mcp, token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args }
  });

  const challenge = response.headers.get('www-authenticate') ?? undefined;
  const result = body?.result as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text ?? '';
  let data: Record<string, unknown> | null = null;
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }

  return {
    status,
    isError: result?.isError === true,
    data,
    envelope: body,
    raw: text,
    ...(challenge ? { challenge } : {})
  };
}

export { MCP_RESOURCE, MCP_ORIGIN, AUTH_ORIGIN };
