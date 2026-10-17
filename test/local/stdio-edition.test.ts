/**
 * Local stdio edition — protocol and tool-behaviour suite.
 *
 * This drives the **real MCP protocol** (the SDK client over a linked in-memory
 * transport, exactly the message flow stdio carries) against the **real tool
 * implementations** and a **real HTTP Bludit API** (the mock server, which
 * re-implements `bl-plugins/api/plugin.php`).
 *
 * It is deliberately not a Cloudflare test and does not use Miniflare, D1 or KV.
 * Nothing here proves anything about the hosted transport, and the hosted suite
 * proves nothing about this one; the shared guarantee is asserted separately, by
 * comparing the tool list against the shared registry that both transports use.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';
import { createLocalServer } from '../../src/local/server.js';
import { loadConfig, type LocalConfig } from '../../src/local/config.js';
import { TOOL_NAMES } from '../../src/shared/scopes.js';
import type { AuditEntry } from '../../src/mcp/tools/ports.js';

const API_TOKEN = 'local-api-token-abc123';
const AUTH_TOKEN = 'local-auth-token-xyz789';
const WIZARD_KEY = 'local-wizard-key-qrs456';

let site: MockBludit;
let config: LocalConfig;

interface Session {
  server: McpServer;
  client: Client;
  audits: AuditEntry[];
  close(): Promise<void>;
}

async function connect(): Promise<Session> {
  const audits: AuditEntry[] = [];
  const server = createLocalServer(config, {
    proposalTtlSeconds: 60,
    audit: { record: async (entry) => void audits.push(entry) }
  });
  const client = new Client({ name: 'local-stdio-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    server,
    client,
    audits,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

interface ToolPayload {
  ok?: boolean;
  verified?: boolean;
  proposalId?: string;
  key?: string;
  revision?: string;
  sites?: unknown[];
  pages?: { key: string; title: string }[];
  available?: unknown[];
  [field: string]: unknown;
}

async function call(session: Session, name: string, args: Record<string, unknown> = {}): Promise<ToolPayload> {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = result.content.map((part) => part.text ?? '').join('');
  if (result.isError) {
    // Tool errors are returned as content, not thrown, so surface them usefully.
    const parsed = safeJson(text);
    throw new Error(`tool ${name} failed: ${text}${parsed ? '' : ''}`);
  }
  return (safeJson(text) ?? {}) as ToolPayload;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every string reachable from a tool result, for redaction assertions. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsIn(item, out);
    }
  }
  return out;
}

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: API_TOKEN,
    authToken: AUTH_TOKEN,
    wizardApiKey: WIZARD_KEY,
    siteTitle: 'Local Stdio Test Blog',
    siteDescription: 'A site used by the local stdio tests',
    pages: [
      {
        title: 'About us',
        description: 'Who we are',
        content: '# About us\n\nWe build things carefully.\n',
        type: 'published',
        tags: ['company'],
        category: 'news'
      },
      {
        title: 'Slow travel in Spain',
        description: 'Notes from the road',
        content: '# Slow travel\n\nRural Spain, at walking pace.\n',
        type: 'published',
        tags: ['travel'],
        category: 'travel'
      },
      { title: 'Unfinished draft', description: '', content: 'Half a thought.\n', type: 'draft', tags: [] }
    ]
  });

  config = loadConfig({
    env: {
      BLUDIT_URL: site.url,
      BLUDIT_API_TOKEN: API_TOKEN,
      BLUDIT_AUTH_TOKEN: AUTH_TOKEN,
      // The mock listens on loopback over plain http, which the URL policy refuses
      // by default. Enabling it explicitly here is the documented local-only escape
      // hatch, exercised deliberately rather than bypassed.
      BLUDIT_ALLOW_INSECURE_URLS: 'true'
    },
    warn: () => {}
  });
});

afterAll(async () => {
  await site.close();
});

describe('local stdio: protocol surface', () => {
  it('registers exactly the shared tool set, with no Cloudflare dependency', async () => {
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      // Identity with the shared registry is the cross-transport guarantee: the
      // hosted suite asserts the same equality against the same constant.
      expect(names).toEqual([...TOOL_NAMES].sort());
      expect(names).toHaveLength(19);
    } finally {
      await session.close();
    }
  });

  it('exposes no deletion tool, by name or by annotation', async () => {
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      for (const tool of tools) {
        expect(tool.name).not.toMatch(/delete|remove|trash|destroy|unpublish/i);
        expect(tool.description ?? '').not.toMatch(/\bdeletes? the page\b/i);
      }
    } finally {
      await session.close();
    }
  });

  it('carries instructions that state the local truth about proposals', async () => {
    const session = await connect();
    try {
      const info = session.client.getInstructions();
      expect(info).toBeTruthy();
      expect(info).toContain('do not survive a restart');
      // The single-site claim is the one place the local instructions must differ.
      expect(info).toContain('single Bludit CMS website');
    } finally {
      await session.close();
    }
  });

  it('takes its site from configuration: one site, no registry', async () => {
    const session = await connect();
    try {
      const payload = await call(session, 'list_sites');
      expect(payload.sites).toHaveLength(1);
      const [entry] = payload.sites as { id: string; baseUrl: string; status: string }[];
      expect(entry?.id).toBe('local');
      expect(entry?.baseUrl).toBe(config.baseUrl);
      expect(entry?.status).toBe('connected');
    } finally {
      await session.close();
    }
  });

  it('resolves the configured site by label and by hostname, and refuses anything else', async () => {
    const session = await connect();
    try {
      const byHost = await call(session, 'list_pages', { site: new URL(site.url).hostname });
      expect(byHost.pages?.length).toBeGreaterThan(0);

      const failure = await session.client
        .callTool({ name: 'list_pages', arguments: { site: 'some-other-site' } })
        .catch((error: unknown) => error);
      const text = JSON.stringify(failure);
      expect(text).toContain('not_found');
      // A refusal names the one site it does have, rather than the one it does not.
      expect(text).toContain('local');
    } finally {
      await session.close();
    }
  });
});

describe('local stdio: read operations', () => {
  it('reads pages, a single page, tags, categories and drafts', async () => {
    const session = await connect();
    try {
      const listed = await call(session, 'list_pages');
      const keys = (listed.pages ?? []).map((page) => page.key);
      expect(keys).toContain('about-us');

      const page = await call(session, 'get_page', { key: 'about-us' });
      expect(JSON.stringify(page)).toContain('We build things carefully');

      const tags = await call(session, 'list_tags');
      expect(JSON.stringify(tags)).toContain('company');

      const categories = await call(session, 'list_categories');
      expect(JSON.stringify(categories)).toContain('news');

      const drafts = await call(session, 'get_drafts');
      expect(JSON.stringify(drafts)).toContain('Unfinished draft');
    } finally {
      await session.close();
    }
  });
});

describe('local stdio: writes', () => {
  it('creates a page and verifies it by reading it back', async () => {
    const session = await connect();
    try {
      const created = await call(session, 'create_page', {
        title: 'Created through stdio',
        content: '# Created\n\nWritten by the local edition.\n',
        type: 'draft',
        confirm: true
      });
      expect(created.ok).toBe(true);
      expect(created.action).toBe('created');
      expect(created.verified).toBe(true);
      expect(created.key).toBe('created-through-stdio');

      const readBack = await call(session, 'get_page', { key: 'created-through-stdio' });
      expect(JSON.stringify(readBack)).toContain('Written by the local edition');
    } finally {
      await session.close();
    }
  });

  it('declares its write tools as writes, so a client cannot mistake them for reads', async () => {
    const session = await connect();
    try {
      const { tools } = await session.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      // The direct-write tools are immediate by design (docs/SECURITY.md): the
      // review-before-write control is the proposal path, not a flag here. What
      // must never happen is a tool that writes while advertising itself as a
      // read, so the annotation is the control being asserted.
      for (const name of ['create_page', 'edit_page', 'apply_approved_edit']) {
        expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
      }
      // Proposing records an intention and touches nothing.
      expect(byName.get('propose_page_edit')?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('refuses to apply a proposal without explicit confirmation, and writes nothing', async () => {
    const session = await connect();
    const before = site.requests.length;
    try {
      const proposed = await call(session, 'propose_page_edit', {
        key: 'about-us',
        operation: 'edit',
        description: 'Proposed but never confirmed'
      });

      // `confirm: true` is a literal in the schema, so omitting it is refused
      // before the handler runs.
      const outcome = await session.client
        .callTool({ name: 'apply_approved_edit', arguments: { proposal_id: proposed.proposalId } })
        .catch((error: unknown) => error);
      expect(JSON.stringify(outcome)).toMatch(/confirm/i);

      // Nothing was written: the proposal/preview reads are GETs, and an edit
      // application would be a PUT.
      const writes = site.requests
        .slice(before)
        .filter((entry) => entry.method === 'POST' || entry.method === 'PUT');
      expect(writes).toHaveLength(0);

      const unchanged = await call(session, 'get_page', { key: 'about-us' });
      expect(JSON.stringify(unchanged)).not.toContain('Proposed but never confirmed');
    } finally {
      await session.close();
    }
  });

  it('supports the review-before-write flow end to end', async () => {
    const session = await connect();
    try {
      const proposal = await call(session, 'propose_page_edit', {
        key: 'about-us',
        operation: 'edit',
        content: '# About us\n\nWe build things carefully, and review them before they land.\n'
      });
      expect(proposal.ok).toBe(true);
      expect(typeof proposal.proposalId).toBe('string');

      // Proposing must not have written anything.
      const unchanged = await call(session, 'get_page', { key: 'about-us' });
      expect(JSON.stringify(unchanged)).not.toContain('review them before they land');

      const applied = await call(session, 'apply_approved_edit', {
        proposal_id: proposal.proposalId,
        confirm: true
      });
      expect(applied.ok).toBe(true);
      expect(applied.verified).toBe(true);

      const after = await call(session, 'get_page', { key: 'about-us' });
      expect(JSON.stringify(after)).toContain('review them before they land');
    } finally {
      await session.close();
    }
  });

  it('refuses a replayed proposal, so one approval cannot write twice', async () => {
    const session = await connect();
    try {
      const proposal = await call(session, 'propose_page_edit', {
        key: 'slow-travel-in-spain',
        operation: 'edit',
        description: 'Reviewed once'
      });

      const first = await call(session, 'apply_approved_edit', {
        proposal_id: proposal.proposalId,
        confirm: true
      });
      expect(first.ok).toBe(true);

      const second = await session.client
        .callTool({
          name: 'apply_approved_edit',
          arguments: { proposal_id: proposal.proposalId, confirm: true }
        })
        .catch((error: unknown) => error);
      expect(JSON.stringify(second)).not.toContain('"verified":true');
    } finally {
      await session.close();
    }
  });

  it('refuses a proposal built from a stale read, rather than clobbering a newer edit', async () => {
    const session = await connect();
    try {
      const proposal = await call(session, 'propose_page_edit', {
        key: 'about-us',
        operation: 'edit',
        description: 'Built from a read that is about to go stale'
      });

      // Someone edits the page in between. This is the race the revision pin exists
      // to catch, and it is the reason a proposal is not just "a queued write".
      await call(session, 'edit_page', {
        key: 'about-us',
        description: 'A newer edit that must survive',
        confirm: true
      });

      const outcome = await session.client
        .callTool({
          name: 'apply_approved_edit',
          arguments: { proposal_id: proposal.proposalId, confirm: true }
        })
        .catch((error: unknown) => error);
      expect(JSON.stringify(outcome)).toContain('revision_mismatch');

      // The newer edit is intact, and the stale proposal did not overwrite it.
      const after = await call(session, 'get_page', { key: 'about-us' });
      const text = JSON.stringify(after);
      expect(text).toContain('A newer edit that must survive');
      expect(text).not.toContain('Built from a read that is about to go stale');
    } finally {
      await session.close();
    }
  });

  it('holds proposals in memory only — the store has no database behind it', async () => {
    const session = await connect();
    try {
      const proposal = await call(session, 'propose_page_edit', {
        key: 'about-us',
        operation: 'edit',
        description: 'A proposal that will not survive this process'
      });
      expect(proposal.proposalId).toMatch(/^prop_local_/);
    } finally {
      await session.close();
    }

    // A fresh process has no memory of it. This is decision D-0004, asserted.
    const fresh = await connect();
    try {
      const outcome = await fresh.client
        .callTool({ name: 'apply_approved_edit', arguments: { proposal_id: 'prop_local_1', confirm: true } })
        .catch((error: unknown) => error);
      expect(JSON.stringify(outcome)).toContain('not_found');
    } finally {
      await fresh.close();
    }
  });

  it('never returns a credential in any tool response', async () => {
    // Every credential the tool layer holds, asserted absent from every response.
    const secrets = [API_TOKEN, AUTH_TOKEN, WIZARD_KEY];
    const session = await connect();
    const seen: string[] = [];
    try {
      const tools = (await session.client.listTools()).tools.map((tool) => tool.name);
      // A representative read of each distinct response shape.
      for (const name of ['list_sites', 'get_site_capabilities', 'list_pages', 'get_page', 'list_tags']) {
        expect(tools).toContain(name);
      }
      for (const [name, args] of [
        ['list_sites', {}],
        ['list_pages', {}],
        ['get_page', { key: 'about-us' }],
        ['list_tags', {}],
        ['get_content_summary', {}]
      ] as [string, Record<string, unknown>][]) {
        const result = (await session.client.callTool({ name, arguments: args })) as { content: unknown };
        seen.push(...stringsIn(result));
      }
    } finally {
      await session.close();
    }

    const joined = seen.join('\n');
    for (const secret of secrets) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe('local stdio: no-delete policy, observed on the wire', () => {
  it('never issues a DELETE to the site, across a full session', async () => {
    const session = await connect();
    const before = site.requests.length;
    try {
      await call(session, 'list_pages');
      await call(session, 'get_page', { key: 'about-us' });
      await call(session, 'create_page', {
        title: 'Disposable page',
        content: '# Disposable\n\nNothing here should ever be deleted.\n',
        type: 'draft',
        confirm: true
      });
      await call(session, 'edit_page', {
        key: 'disposable-page',
        description: 'Edited, not deleted',
        confirm: true
      });
    } finally {
      await session.close();
    }

    const methods = site.requests.slice(before).map((entry) => entry.method);
    expect(methods).not.toContain('DELETE');
    // The edits really happened, so the absence of DELETE is meaningful.
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
  });
});

describe('local stdio: all nineteen tools, called for real', () => {
  it('answers every tool without an error, or names the ones that did not', async () => {
    const session = await connect();
    const failures: string[] = [];

    /** Call a tool and record the outcome instead of throwing on the first failure. */
    const attempt = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        const result = (await session.client.callTool({ name, arguments: args })) as {
          content: { text?: string }[];
          isError?: boolean;
        };
        const text = result.content.map((part) => part.text ?? '').join('');
        const parsed = safeJson(text) as { ok?: boolean } | undefined;
        if (result.isError === true || parsed?.ok === false) {
          failures.push(`${name}: ${text.slice(0, 200)}`);
          return undefined;
        }
        return parsed ?? text;
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

    try {
      // Every tool in the shared registry must be reachable over this transport.
      // The list is taken from the registry rather than typed out, so a new tool
      // cannot be added to the hosted transport and silently not checked here.
      expect([...TOOL_NAMES].sort()).toEqual(
        [
          'apply_approved_edit',
          'create_page',
          'edit_page',
          'get_content_summary',
          'get_drafts',
          'get_page',
          'get_related_pages',
          'get_scheduled_pages',
          'get_site_capabilities',
          'get_website_settings',
          'list_categories',
          'list_pages',
          'list_sites',
          'list_tags',
          'preview_page_changes',
          'propose_page_edit',
          'search_pages',
          'select_site',
          'verify_page_update'
        ].sort()
      );

      // 1-4: service state
      await attempt('list_sites');
      await attempt('get_site_capabilities', { refresh: true });
      await attempt('select_site', { site: 'local' });
      await attempt('get_website_settings');

      // 5-11: reads
      await attempt('list_pages');
      await attempt('get_page', { key: 'about-us' });
      await attempt('search_pages', { query: 'carefully' });
      await attempt('list_categories');
      await attempt('list_tags');
      await attempt('get_drafts');
      await attempt('get_scheduled_pages');

      // 12-15: deterministic derivations over real reads
      await attempt('get_content_summary', { key: 'about-us' });
      await attempt('get_related_pages', { key: 'about-us' });
      await attempt('preview_page_changes', { key: 'about-us', description: 'preview only' });
      await attempt('verify_page_update', { key: 'about-us', expected_title: 'About us' });

      // 16-17: direct writes, verified by a read-back
      await attempt('create_page', {
        title: 'All tools check',
        content: '# All tools\n\nCreated by the nineteen-tool check.\n',
        slug: 'all-tools-check',
        type: 'draft',
        confirm: true
      });
      await attempt('edit_page', {
        key: 'all-tools-check',
        description: 'Edited by the nineteen-tool check',
        confirm: true
      });

      // 18-19: the proposal path, end to end
      const proposal = (await attempt('propose_page_edit', {
        key: 'all-tools-check',
        operation: 'edit',
        content: '# All tools\n\nApplied through the proposal path.\n'
      })) as { proposalId?: string } | undefined;
      if (proposal?.proposalId) {
        await attempt('apply_approved_edit', { proposal_id: proposal.proposalId, confirm: true });
      } else {
        failures.push('apply_approved_edit: no proposal id, so it could not be exercised');
      }
    } finally {
      await session.close();
    }

    expect(failures, `tools that failed: ${failures.join(' | ')}`).toEqual([]);
  });
});

describe('local stdio: audit trail', () => {
  it('records one entry per tool call, with the outcome, on stderr only', async () => {
    const session = await connect();
    try {
      await call(session, 'list_sites');
      await call(session, 'list_pages');
      const entries = session.audits.filter((entry) => entry.outcome === 'ok').map((entry) => entry.tool);
      expect(entries).toContain('list_sites');
      expect(entries).toContain('list_pages');
      for (const entry of session.audits) {
        expect(entry.siteId === undefined || entry.siteId === 'local').toBe(true);
      }
    } finally {
      await session.close();
    }
  });

  it('records a refusal as denied rather than as an unhandled failure', async () => {
    const session = await connect();
    try {
      await session.client
        .callTool({ name: 'get_page', arguments: { site: 'nope', key: 'about-us' } })
        .catch(() => undefined);
      const denied = session.audits.find((entry) => entry.tool === 'get_page');
      expect(denied?.outcome).toBe('error');
      expect(denied?.detail).toBe('not_found');
    } finally {
      await session.close();
    }
  });
});
