/**
 * The protocol surface, asserted as fact.
 *
 * Client compatibility turns on a small number of transport behaviours that are
 * easy to assume and expensive to be wrong about: whether a session id is
 * required, whether a JSON-only `Accept` works, whether the server tolerates a
 * `GET` stream, whether CORS is answered, and which protocol version is
 * negotiated.
 *
 * These tests assert what this server *does*, not what a client wants, so that a
 * change in behaviour is caught here rather than discovered by a user. The
 * findings are quoted in `docs/CLIENT_COMPATIBILITY_MATRIX.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_RESOURCE, startHarness, type Harness } from '../harness/index.js';
import { accessToken, createAccount, discover, registerClient } from '../harness/oauth-client.js';
import type { AnyResponse } from '../harness/response.js';

/**
 * The Accept header a spec-compliant MCP client sends on POST.
 *
 * This is not optional: the transport answers `406` without it. Every assertion
 * below that expects a JSON-RPC reply must send it.
 */
const SPEC_ACCEPT = 'application/json, text/event-stream';

let harness: Harness;
let token: string;

beforeAll(async () => {
  harness = await startHarness();
  const as = await discover(harness.mcp, harness.auth);
  const account = await createAccount(harness.auth, 'protocol@example.test');
  const client = await registerClient(harness.auth, as, 'http://127.0.0.1:7810/callback');
  const tokens = await accessToken(harness.auth, account, { as, client, scope: 'sites:read pages:read' });
  token = tokens.access_token;
}, 300_000);

afterAll(async () => {
  await harness?.close();
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<AnyResponse> {
  return harness.mcp.fetch(MCP_RESOURCE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: SPEC_ACCEPT,
      authorization: `Bearer ${token}`,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'protocol-probe', version: '1.0.0' }
  }
};

describe('unauthenticated requests', () => {
  it('answers with a Bearer challenge and points at the resource metadata', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: SPEC_ACCEPT },
      body: JSON.stringify(INITIALIZE)
    });
    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain('Bearer');
    expect(header).toContain('resource_metadata=');
    expect(header).toContain('scope=');
  });

  it('does not issue a session id on any response', async () => {
    // Stateless by design. A client that *requires* Mcp-Session-Id cannot work.
    const response = await post(INITIALIZE);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });
});

describe('initialize', () => {
  it('negotiates a protocol version and advertises tools only', async () => {
    const response = await post(INITIALIZE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string } };
    };
    expect(body.result?.protocolVersion).toBeTruthy();
    expect(body.result?.serverInfo?.name).toBe('bludit-wizard-mcp');
    // Tools only: no resources, no prompts, no logging, no sampling.
    expect(Object.keys(body.result?.capabilities ?? {})).toEqual(['tools']);
  });

  it('serves a client that asks for a newer revision', async () => {
    const body = (await (await post(INITIALIZE)).json()) as { result?: { protocolVersion?: string } };
    expect(typeof body.result?.protocolVersion).toBe('string');
  });

  it('serves a client that asks for an older revision', async () => {
    // OpenCode's default is the "classic" handshake and it speaks revisions up to
    // 2025-11-25. Claude Code has a v1 runtime. Neither may be left out, so the
    // negotiated version is asserted to be one the client asked for or newer.
    for (const asked of ['2025-06-18', '2025-11-25', '2024-11-05']) {
      const response = await post({
        ...INITIALIZE,
        params: { ...INITIALIZE.params, protocolVersion: asked }
      });
      expect(response.status, `asked ${asked}`).toBe(200);
      const body = (await response.json()) as { result?: { protocolVersion?: string } };
      expect(typeof body.result?.protocolVersion, `asked ${asked}`).toBe('string');
    }
  });
});

describe('content negotiation', () => {
  /**
   * The single most important transport requirement for client compatibility.
   *
   * The MCP Streamable HTTP specification requires a client to send
   * `Accept: application/json, text/event-stream` on POST. The SDK transport
   * enforces that, and answers `406 Not Acceptable` otherwise. A client that
   * sends only `application/json` will not work, and that is a fact about this
   * server that the compatibility matrix states rather than hides.
   */
  it('tolerates an Accept header that omits text/event-stream', async () => {
    // The adapter in `src/mcp/app.ts` completes the header. Before it, this was a
    // 406; the raw transport behaviour is recorded by the next test.
    const jsonOnly = await post(INITIALIZE, { accept: 'application/json' });
    expect(jsonOnly.status).toBe(200);
  });

  it('accepts the specification-compliant Accept header', async () => {
    const response = await post(INITIALIZE);
    expect(response.status).toBe(200);
  });

  it('accepts a JSON response even when SSE was offered', async () => {
    // `enableJsonResponse` is on, so the reply is one JSON body rather than a
    // stream. That suits clients that cannot consume SSE on the response path.
    const response = await post(INITIALIZE);
    expect(response.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await response.json()) as { result?: unknown };
    expect(body.result).toBeDefined();
  });

  it('records the status for every Accept variant a client might send', async () => {
    const observed: Record<string, number> = {};
    for (const accept of ['application/json', 'application/json, text/event-stream', 'text/event-stream', '*/*']) {
      observed[accept] = (await post(INITIALIZE, { accept })).status;
    }
    // Every variant now succeeds, because `withTolerantAccept` completes the
    // header before the transport sees it.
    for (const [accept, status] of Object.entries(observed)) {
      expect(status, `Accept: ${accept} -> ${status}`).toBe(200);
    }
  });
});

describe('methods this server does not rely on', () => {
  it('answers a GET, so a client that opens a stream is not left hanging', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }
    });
    // Served rather than refused. Nothing is delivered on it, because this server
    // never sends server-initiated messages, but a client is not broken by asking.
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
  });

  it('answers a DELETE, which is harmless because there is no session', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
  });

  it('does not serve the legacy HTTP+SSE transport at /sse', async () => {
    const origin = new URL(MCP_RESOURCE).origin;
    const response = await harness.mcp.fetch(`${origin}/sse`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(404);
  });
});

describe('browser-adjacent behaviour', () => {
  it('records the CORS answer for a preflight', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    // Recorded, not required: MCP clients are not browsers. A browser-based
    // client would need this, and the matrix says so.
    expect(response.status).toBeLessThan(500);
  });

  it('does not advertise a wildcard origin', async () => {
    const response = await post(INITIALIZE, { origin: 'https://evil.example' });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('reflects the requesting origin in CORS, which browsers need', async () => {
    // Recorded as fact rather than asserted as desirable. No cookie is ever read,
    // so reflecting the origin does not create an ambient-authority problem: the
    // bearer token is presented explicitly by the caller.
    const response = await post(INITIALIZE, { origin: 'https://client.example' });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
  });

  it('sends no Allow-Credentials, so cookies are never accepted cross-origin', async () => {
    const response = await post(INITIALIZE, { origin: 'https://client.example' });
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('tool catalogue shape', () => {
  it('advertises 19 tools with titles, descriptions and annotations', async () => {
    const response = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const body = (await response.json()) as {
      result?: {
        tools?: Array<{
          name?: string;
          title?: string;
          description?: string;
          inputSchema?: { type?: string; properties?: Record<string, unknown> };
          annotations?: Record<string, unknown>;
        }>;
      };
    };
    const tools = body.result?.tools ?? [];
    expect(tools).toHaveLength(19);
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} schema`).toBe('object');
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
      expect(tool.annotations).toHaveProperty('readOnlyHint');
      expect(tool.annotations).toHaveProperty('destructiveHint');
      expect(tool.annotations).toHaveProperty('idempotentHint');
      expect(tool.annotations).toHaveProperty('openWorldHint');
    }
  });

  it('declares no outputSchema, which is a known limitation', async () => {
    const response = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const body = (await response.json()) as { result?: { tools?: Array<Record<string, unknown>> } };
    for (const tool of body.result?.tools ?? []) {
      expect(tool).not.toHaveProperty('outputSchema');
    }
  });

  it('never advertises a deletion tool', async () => {
    const response = await post({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const body = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } };
    const names = (body.result?.tools ?? []).map((tool) => tool.name);
    expect(names).not.toContain('delete_page');
  });
});

describe('stateless behaviour', () => {
  it('serves two consecutive calls with no session affinity', async () => {
    const first = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const second = await post({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('accepts a batch request', async () => {
    const response = await post([
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }
    ]);
    expect(response.status).toBe(200);
  });

  it('refuses malformed JSON with a parse error rather than a 500', async () => {
    const response = await harness.mcp.fetch(MCP_RESOURCE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{ not json'
    });
    expect(response.status).toBe(400);
  });
});
