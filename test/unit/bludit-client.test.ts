/**
 * Bludit API client tests.
 *
 * These assert the transport rules that are easy to get wrong and that the
 * upstream server documents only in a comment: where the API token goes for each
 * method, how the legacy envelope is interpreted, and what happens when the
 * upstream misbehaves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BluditClient, assertValidPageKey, pageRevision } from '../../src/bludit/client.js';
import { ToolError } from '../../src/shared/errors.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function clientWith(responder: (captured: Captured) => Response): { client: BluditClient; calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const captured: Captured = { url, method: init?.method ?? 'GET', headers, body: (init?.body as string) ?? null };
    calls.push(captured);
    return responder(captured);
  });

  return {
    client: new BluditClient(
      {
        baseUrl: 'https://blog.example.com',
        apiToken: 'API-TOKEN',
        authToken: 'AUTH-TOKEN',
        wizardApiKey: '',
        wizardApiBase: ''
      },
      { policy: { allowInsecure: false } }
    ),
    calls
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('page key validation', () => {
  it('accepts plain and hierarchical keys', () => {
    expect(assertValidPageKey('about')).toBe('about');
    expect(assertValidPageKey('parent/child')).toBe('parent/child');
    expect(assertValidPageKey('  spaced  ')).toBe('spaced');
  });

  it('rejects traversal, NUL and absolute keys', () => {
    expect(() => assertValidPageKey('..')).toThrow(ToolError);
    expect(() => assertValidPageKey('a/../../etc')).toThrow(ToolError);
    expect(() => assertValidPageKey('a\0b')).toThrow(ToolError);
    expect(() => assertValidPageKey('/etc/passwd')).toThrow(ToolError);
    expect(() => assertValidPageKey('')).toThrow(ToolError);
    expect(() => assertValidPageKey('x'.repeat(600))).toThrow(ToolError);
  });
});

describe('token placement follows the API plugin', () => {
  it('sends the API token in the query string for GET', async () => {
    const { client, calls } = clientWith(() =>
      jsonResponse({ status: '0', message: 'ok', data: [], meta: { total: 0 } })
    );
    await client.listPages({ numberOfItems: 5 });
    const call = calls[0] as Captured;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('token=API-TOKEN');
    expect(call.body).toBeNull();
  });

  it('adds the auth token to the query string only when authentication is required', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: '0', message: 'ok', data: {} }));
    await client.getSettings();
    expect((calls[0] as Captured).url).toContain('authentication=AUTH-TOKEN');
  });

  it('sends tokens in the JSON body for POST', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: '0', data: { key: 'new-page' } }, 201));
    await client.createPage({ title: 'New', content: 'Body' });
    const call = calls[0] as Captured;
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body as string) as Record<string, unknown>;
    expect(body.token).toBe('API-TOKEN');
    expect(body.authentication).toBe('AUTH-TOKEN');
    expect(body.title).toBe('New');
    expect(call.url).not.toContain('token=');
  });

  it('sends tokens in the JSON body for PUT', async () => {
    const { client, calls } = clientWith((captured) => {
      if (captured.method === 'PUT') return jsonResponse({ status: '0', data: { key: 'about' } });
      return jsonResponse({ status: '0', data: { key: 'about', title: 'About', contentRaw: 'x' } });
    });
    await client.editPage('about', { title: 'About v2' });
    const put = calls.find((call) => call.method === 'PUT') as Captured;
    const body = JSON.parse(put.body as string) as Record<string, unknown>;
    expect(body.token).toBe('API-TOKEN');
    expect(body.authentication).toBe('AUTH-TOKEN');
    expect(body.title).toBe('About v2');
  });

  it('refuses a write when no auth token is stored', async () => {
    const client = new BluditClient(
      { baseUrl: 'https://blog.example.com', apiToken: 'x', authToken: '', wizardApiKey: '', wizardApiBase: '' },
      { policy: { allowInsecure: false } }
    );
    await expect(client.createPage({ title: 'a', content: 'b' })).rejects.toMatchObject({ code: 'site_auth_failed' });
  });

  it('percent-encodes each page key segment', async () => {
    const { client, calls } = clientWith(() => jsonResponse({ status: '0', data: { key: 'a b/c d', title: 't' } }));
    await client.getPage('a b/c d');
    expect((calls[0] as Captured).url).toContain('/api/pages/a%20b/c%20d');
  });
});

describe('envelope and status interpretation', () => {
  it('accepts the legacy success envelope', async () => {
    const { client } = clientWith(() => jsonResponse({ status: '0', message: 'ok', data: [{ key: 'a' }] }));
    const result = await client.listPages({});
    expect(result.data).toHaveLength(1);
  });

  it('treats a legacy failure envelope as an error even with HTTP 200', async () => {
    const { client } = clientWith(() => jsonResponse({ status: '1', message: 'Something failed' }));
    await expect(client.listPages({})).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('maps HTTP 401 and 403 to site_auth_failed', async () => {
    const { client } = clientWith(() => jsonResponse({ status: '1', message: 'Unauthorized' }, 401));
    await expect(client.listPages({})).rejects.toMatchObject({ code: 'site_auth_failed' });
  });

  it('maps HTTP 404 to not_found', async () => {
    const { client } = clientWith(() => jsonResponse({ status: '1', message: 'Page not found.' }, 404));
    await expect(client.getPage('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps HTTP 500 to upstream_error', async () => {
    const { client } = clientWith(() => jsonResponse({ status: '1', message: 'boom' }, 500));
    await expect(client.listPages({})).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('refuses a 200 response whose body is not JSON instead of reporting an empty result', async () => {
    const { client } = clientWith(
      () => new Response('<!doctype html><title>maintenance</title>', { status: 200, headers: { 'content-type': 'text/html' } })
    );
    await expect(client.listPages({})).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('still accepts an empty 200 body', async () => {
    const { client } = clientWith(() => new Response('', { status: 200 }));
    const result = await client.listPages({});
    expect(result.data).toBeUndefined();
  });

  it('never echoes a token found in an upstream message', async () => {
    const { client } = clientWith(() =>
      jsonResponse({ status: '1', message: 'bad token=API-TOKEN&authentication=AUTH-TOKEN' })
    );
    await expect(client.listPages({})).rejects.toThrow(/token=\[redacted\]/);
    await expect(client.listPages({})).rejects.not.toThrow(/API-TOKEN/);
  });

  it('maps a transport failure to site_unreachable', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('connection refused');
    });
    await expect(client.listPages({})).rejects.toMatchObject({ code: 'site_unreachable' });
  });

  it('reports the created key when Bludit omits the page object', async () => {
    const { client } = clientWith((captured) => {
      if (captured.method === 'POST') return jsonResponse({ status: '0', data: { key: 'brand-new' } }, 201);
      return jsonResponse({ status: '0', data: { key: 'brand-new', title: 'Brand new', contentRaw: 'x' } });
    });
    const page = await client.createPage({ title: 'Brand new', content: 'x' });
    expect(page.key).toBe('brand-new');
  });
});

describe('revision identity', () => {
  const base = {
    key: 'about',
    title: 'About',
    description: 'd',
    type: 'published',
    slug: 'about',
    contentRaw: 'body',
    dateRaw: '2026-01-01 00:00:00',
    uuid: 'u1',
    category: '',
    tags: []
  };

  it('is stable for identical pages', async () => {
    expect(await pageRevision(base)).toBe(await pageRevision({ ...base }));
  });

  it('changes when any write-relevant field changes', async () => {
    for (const change of [
      { title: 'About v2' },
      { contentRaw: 'body ' },
      { type: 'draft' },
      { slug: 'about-v2' },
      { tags: ['x'] },
      { category: 'news' },
      { dateRaw: '2026-02-02 00:00:00' }
    ]) {
      expect(await pageRevision({ ...base, ...change })).not.toBe(await pageRevision(base));
    }
  });
});

describe('Wizard extension', () => {
  it('reports the capability as unavailable when nothing is configured', async () => {
    const { client } = clientWith(() => jsonResponse({ ok: true }));
    expect(client.hasWizardExtension).toBe(false);
    await expect(client.wizardSite()).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  it('sends the Wizard bearer key and maps a 404 to capability_unavailable', async () => {
    const calls: Captured[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: null
      });
      return new Response('not found', { status: 404 });
    });

    const client = new BluditClient(
      {
        baseUrl: 'https://blog.example.com',
        apiToken: 'API-TOKEN',
        authToken: 'AUTH-TOKEN',
        wizardApiKey: 'WIZARD-KEY',
        wizardApiBase: 'https://blog.example.com/api/wizard'
      },
      { policy: { allowInsecure: false } }
    );

    expect(client.hasWizardExtension).toBe(true);
    await expect(client.wizardSite()).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(JSON.stringify(calls[0]?.headers)).toContain('Bearer WIZARD-KEY');
  });
});
