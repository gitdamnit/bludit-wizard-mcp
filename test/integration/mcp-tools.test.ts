/**
 * End-to-end MCP tool tests against a mock Bludit site.
 *
 * Everything here goes through the real HTTP surfaces: the authorization
 * server's HTML pages for site connection, the OAuth token endpoint, and the
 * MCP Streamable HTTP endpoint. Nothing is stubbed inside the application.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockBludit } from '../harness/mock-bludit.js';
import { startMockBludit } from '../harness/mock-bludit.js';
import { startHarness, type Harness } from '../harness/index.js';
import {
  accessToken,
  createAccount,
  discover,
  initialize,
  listTools,
  registerClient,
  callTool,
  type Account,
  type DiscoveredServer
} from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

const ALL_SCOPES = 'sites:read pages:read pages:write settings:read offline_access';

let harness: Harness;
let site: MockBludit;
let account: Account;
let as: DiscoveredServer;
let token: string;
let siteId: string;

beforeAll(async () => {
  site = await startMockBludit({
    apiToken: 'api-token-e2e',
    authToken: 'auth-token-e2e',
    siteTitle: 'E2E Test Blog',
    siteDescription: 'A site used by the end-to-end tests',
    pages: [
      {
        title: 'About us',
        description: 'Who we are',
        content: '# About us\n\nWe build things carefully.\n',
        type: 'published',
        tags: ['company', 'about'],
        category: 'news'
      },
      {
        title: 'Slow travel in Spain',
        description: 'Notes from the road',
        content: '# Slow travel\n\nRural Spain, at walking pace.\n\n## Where to stay\n\nSmall towns.\n',
        type: 'published',
        tags: ['travel', 'spain'],
        category: 'travel'
      },
      {
        title: 'Unfinished draft',
        description: '',
        content: '# Draft\n\nNot ready yet.\n',
        type: 'draft',
        tags: [],
        category: ''
      },
      {
        title: 'Launch announcement',
        description: 'Coming soon',
        content: '# Launch\n\nScheduled for next month.\n',
        type: 'scheduled',
        date: '2099-01-01 09:00:00',
        tags: ['company'],
        category: 'news'
      }
    ]
  });

  harness = await startHarness();
  account = await createAccount(harness.auth, 'tools@example.test');
  as = await discover(harness.mcp, harness.auth);
  const client = await registerClient(harness.auth, as);
  const tokens = await accessToken(harness.auth, account, { as, client, scope: ALL_SCOPES });
  token = tokens.access_token;

  site.setChallenge('');
  const outcome = await connectSiteWithWellKnownFile(
    harness.auth,
    account,
    {
      siteUrl: site.url,
      apiToken: 'api-token-e2e',
      authToken: 'auth-token-e2e',
      label: 'E2E site',
      edition: 'community'
    },
    (challenge) => site.setChallenge(challenge)
  );
  if (!outcome.ok) {
    const message = /<p class="error">([^<]*)<\/p>/.exec(outcome.html)?.[1] ?? outcome.html.slice(0, 800);
    const details = /<pre class="muted"[^>]*>([\s\S]*?)<\/pre>/.exec(outcome.html)?.[1] ?? '';
    throw new Error(`Site connection failed: ${message}\n${details}`);
  }
  siteId = outcome.siteId as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await site?.close();
});

describe('MCP protocol surface', () => {
  it('initializes and advertises the server', async () => {
    const result = await initialize(harness.mcp, token);
    const serverInfo = (result?.result as { serverInfo?: { name: string; version: string } } | undefined)?.serverInfo;
    expect(serverInfo?.name).toBe('bludit-wizard-mcp');
    expect(serverInfo?.version).toBe('0.1.0');
  });

  it('lists every tool and never exposes page deletion', async () => {
    const tools = await listTools(harness.mcp, token);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
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
    expect(names).not.toContain('delete_page');
    for (const tool of tools) expect(tool.description ?? '').not.toBe('');
  });

  it('rejects a request with no bearer token', async () => {
    const result = await callTool(harness.mcp, '', 'list_sites');
    expect(result.status).toBe(401);
  });

  it('rejects a syntactically invalid bearer token', async () => {
    const result = await callTool(harness.mcp, 'not-a-real-token', 'list_sites');
    expect(result.status).toBe(401);
  });
});

describe('site tools', () => {
  it('lists the connected site without leaking credentials', async () => {
    const result = await callTool(harness.mcp, token, 'list_sites', { include_capabilities: true });
    expect(result.isError).toBe(false);
    const data = result.data as { ok: boolean; count: number; sites: Array<Record<string, unknown>> };
    expect(data.ok).toBe(true);
    expect(data.count).toBe(1);
    const site0 = data.sites[0] as Record<string, unknown>;
    expect(site0.label).toBe('E2E site');
    expect(site0.declaredEdition).toBe('community');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('api-token-e2e');
    expect(serialized).not.toContain('auth-token-e2e');
    expect(serialized).not.toContain('_enc');
  });

  it('resolves a site reference by hostname', async () => {
    const result = await callTool(harness.mcp, token, 'select_site', { site: '127.0.0.1' });
    expect(result.isError).toBe(false);
    const data = result.data as { ok: boolean; site: { id: string } };
    expect(data.site.id).toBe(siteId);
  });

  it('reports capabilities and records the absence of the Wizard extension', async () => {
    const result = await callTool(harness.mcp, token, 'get_site_capabilities', { refresh: true });
    expect(result.isError).toBe(false);
    const data = result.data as {
      capabilities: {
        bluditApi: { reachable: boolean; readOk: boolean; authenticatedOk: boolean };
        wizardExtension: { available: boolean };
        endpoints: Record<string, { supported: boolean | 'documented' }>;
        edition: { declared: string; detected: string };
        notes: string[];
      };
    };
    expect(data.capabilities.bluditApi.readOk).toBe(true);
    expect(data.capabilities.bluditApi.authenticatedOk).toBe(true);
    expect(data.capabilities.wizardExtension.available).toBe(false);
    expect(data.capabilities.endpoints.search?.supported).toBe(false);
    expect(data.capabilities.endpoints.users?.supported).toBe('documented');
    expect(data.capabilities.edition).toEqual({
      declared: 'community',
      detected: 'unknown',
      note: expect.stringContaining('not independently verified')
    });
  });

  it('reads website settings', async () => {
    const result = await callTool(harness.mcp, token, 'get_website_settings', {});
    expect(result.isError).toBe(false);
    const data = result.data as { settings: { title: string } };
    expect(data.settings.title).toBe('E2E Test Blog');
  });
});

describe('page read tools', () => {
  it('lists published pages with pagination meta', async () => {
    const result = await callTool(harness.mcp, token, 'list_pages', { numberOfItems: -1 });
    const data = result.data as { count: number; meta: { total: number }; pages: Array<{ key: string }> };
    expect(data.meta.total).toBe(2);
    expect(data.count).toBe(2);
    expect(data.pages.map((page) => page.key).sort()).toEqual(['about-us', 'slow-travel-in-spain']);
  });

  it('lists all page types when every filter is enabled', async () => {
    const result = await callTool(harness.mcp, token, 'list_pages', {
      published: true,
      draft: true,
      scheduled: true,
      numberOfItems: -1
    });
    const data = result.data as { count: number };
    expect(data.count).toBe(4);
  });

  it('returns full page content and a stable revision', async () => {
    const first = await callTool(harness.mcp, token, 'get_page', { key: 'about-us' });
    expect(first.isError).toBe(false);
    const data = first.data as { page: { contentRaw: string; title: string }; revision: string };
    expect(data.page.title).toBe('About us');
    expect(data.page.contentRaw).toContain('We build things carefully');
    expect(data.revision).toMatch(/^[0-9a-f]{64}$/);

    const second = await callTool(harness.mcp, token, 'get_page', { key: 'about-us' });
    expect((second.data as { revision: string }).revision).toBe(data.revision);
  });

  it('reports not_found for a missing page', async () => {
    const result = await callTool(harness.mcp, token, 'get_page', { key: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('rejects a page key containing a traversal sequence', async () => {
    const result = await callTool(harness.mcp, token, 'get_page', { key: '../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('invalid_input');
  });

  it('lists drafts', async () => {
    const result = await callTool(harness.mcp, token, 'get_drafts', {});
    const data = result.data as { count: number; pages: Array<{ key: string }> };
    expect(data.count).toBe(1);
    expect(data.pages[0]?.key).toBe('unfinished-draft');
  });

  it('lists scheduled pages sorted by date', async () => {
    const result = await callTool(harness.mcp, token, 'get_scheduled_pages', {});
    const data = result.data as { count: number; pages: Array<{ scheduledFor: string }> };
    expect(data.count).toBe(1);
    expect(data.pages[0]?.scheduledFor).toBe('2099-01-01 09:00:00');
  });

  it('lists tags and categories', async () => {
    const tags = await callTool(harness.mcp, token, 'list_tags', {});
    const tagData = tags.data as { tags: Array<{ key: string }> };
    expect(tagData.tags.map((tag) => tag.key).sort()).toEqual(['about', 'company', 'spain', 'travel']);

    const categories = await callTool(harness.mcp, token, 'list_categories', {});
    const categoryData = categories.data as { categories: Array<{ key: string }> };
    expect(categoryData.categories.map((category) => category.key).sort()).toEqual(['news', 'travel']);
  });
});

describe('deterministic intelligence tools', () => {
  it('searches titles without touching page bodies', async () => {
    const result = await callTool(harness.mcp, token, 'search_pages', { query: 'slow travel' });
    const data = result.data as { count: number; matches: Array<{ key: string; matchedIn: string[] }>; method: string };
    expect(data.count).toBe(1);
    expect(data.matches[0]?.key).toBe('slow-travel-in-spain');
    expect(data.matches[0]?.matchedIn).toContain('title');
    expect(data.method).toBe('deterministic_substring_filter');
  });

  it('searches page bodies only when asked, and notes the cost', async () => {
    const result = await callTool(harness.mcp, token, 'search_pages', {
      query: 'walking pace',
      include_content: true,
      scan_limit: 10
    });
    const data = result.data as { count: number; matches: Array<{ matchedIn: string[]; excerpt?: string }> };
    expect(data.count).toBe(1);
    expect(data.matches[0]?.matchedIn).toContain('content');
    expect(data.matches[0]?.excerpt).toContain('walking pace');
  });

  it('refuses a content scan wide enough to exhaust the subrequest budget', async () => {
    // Each fetched page is a separate subrequest, and a Workers request may make
    // only 50 on the free plan. The tool refuses rather than failing mid-scan.
    const result = await callTool(harness.mcp, token, 'search_pages', {
      query: 'walking pace',
      include_content: true,
      scan_limit: 200
    });
    expect(result.isError).toBe(true);
    const error = (result.data as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('separate upstream request');
  });

  it('summarizes page content deterministically', async () => {
    const result = await callTool(harness.mcp, token, 'get_content_summary', { key: 'slow-travel-in-spain' });
    const data = result.data as {
      summary: { words: number; headings: Array<{ level: number; text: string }>; warnings: string[] };
    };
    expect(data.summary.words).toBeGreaterThan(5);
    expect(data.summary.headings.map((heading) => heading.text)).toContain('Where to stay');
    // The page has a description, so only the short-content warning applies.
    expect(data.summary.warnings).toEqual(['Content is short (under 80 words).']);

    const undocumented = await callTool(harness.mcp, token, 'get_content_summary', { key: 'unfinished-draft' });
    const undocumentedData = undocumented.data as { summary: { warnings: string[] } };
    expect(undocumentedData.summary.warnings).toContain('No description set.');
  });

  it('ranks related pages by shared tags and category', async () => {
    const result = await callTool(harness.mcp, token, 'get_related_pages', { key: 'about-us' });
    const data = result.data as { count: number; related: Array<{ key: string; reasons: string[] }> };
    const launch = data.related.find((entry) => entry.key === 'launch-announcement');
    expect(launch).toBeDefined();
    expect(launch?.reasons.join(' ')).toContain('same category');
  });
});

describe('write tools', () => {
  it('creates a page, verifies it, and reads it back', async () => {
    const result = await callTool(harness.mcp, token, 'create_page', {
      title: 'A brand new post',
      content: '# A brand new post\n\nBody text.\n',
      type: 'draft',
      tags: 'testing,new'
    });
    expect(result.isError).toBe(false);
    const data = result.data as { ok: boolean; key: string; verified: boolean; action: string };
    expect(data.ok).toBe(true);
    expect(data.verified).toBe(true);
    expect(data.action).toBe('created');
    expect(site.pages.get(data.key)?.title).toBe('A brand new post');
    expect(site.pages.get(data.key)?.tags).toEqual(['testing', 'new']);
  });

  it('requires a title and content to create', async () => {
    const result = await callTool(harness.mcp, token, 'create_page', { title: 'No body' });
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('invalid_input');
  });

  it('edits a page and reports the changed fields', async () => {
    const result = await callTool(harness.mcp, token, 'edit_page', {
      key: 'about-us',
      title: 'About the team',
      content: '# About the team\n\nWe build things very carefully.\n'
    });
    expect(result.isError).toBe(false);
    const data = result.data as {
      ok: boolean;
      key: string;
      keyChanged: boolean;
      changedFields: Array<{ field: string }>;
      contentChanged: boolean;
    };
    expect(data.ok).toBe(true);
    expect(data.keyChanged).toBe(false);
    expect(data.changedFields.map((change) => change.field)).toEqual(['title']);
    expect(data.contentChanged).toBe(true);
  });

  it('refuses an edit whose expected revision is stale', async () => {
    const read = await callTool(harness.mcp, token, 'get_page', { key: 'about-us' });
    const revision = (read.data as { revision: string }).revision;

    // Someone else edits the page first.
    await callTool(harness.mcp, token, 'edit_page', { key: 'about-us', description: 'Changed by someone else' });

    const stale = await callTool(harness.mcp, token, 'edit_page', {
      key: 'about-us',
      title: 'Too late',
      expected_revision: revision
    });
    expect(stale.isError).toBe(true);
    expect((stale.data as { error: { code: string } }).error.code).toBe('revision_mismatch');
    expect(site.pages.get('about-us')?.title).toBe('About the team');
  });

  it('refuses to clear page content, which Bludit would ignore anyway', async () => {
    const result = await callTool(harness.mcp, token, 'edit_page', { key: 'about-us', content: '' });
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('invalid_input');
  });

  it('previews changes without writing anything', async () => {
    const before = site.pages.get('slow-travel-in-spain')?.content;
    const result = await callTool(harness.mcp, token, 'preview_page_changes', {
      key: 'slow-travel-in-spain',
      content: '# Slow travel\n\nRural Spain, at walking pace.\n\n## Where to stay\n\nSmall towns and quiet hotels.\n'
    });
    const data = result.data as {
      wouldChange: boolean;
      contentDiff: { added: number; removed: number; patch: string } | null;
      fieldChanges: Array<{ field: string; changed: boolean }>;
    };
    expect(data.wouldChange).toBe(true);
    expect(data.contentDiff?.patch).toContain('quiet hotels');
    expect(site.pages.get('slow-travel-in-spain')?.content).toBe(before);
  });

  it('verifies a page against expectations field by field', async () => {
    const pass = await callTool(harness.mcp, token, 'verify_page_update', {
      key: 'about-us',
      expected_title: 'About the team',
      expected_type: 'published',
      content_contains: 'very carefully'
    });
    const passData = pass.data as { ok: boolean; checks: Array<{ check: string; ok: boolean }> };
    expect(passData.ok).toBe(true);
    expect(passData.checks.every((check) => check.ok)).toBe(true);

    const fail = await callTool(harness.mcp, token, 'verify_page_update', {
      key: 'about-us',
      expected_title: 'Something else'
    });
    const failData = fail.data as { ok: boolean; checks: Array<{ check: string; ok: boolean; actual?: string }> };
    expect(failData.ok).toBe(false);
    expect(failData.checks[0]?.actual).toBe('About the team');
  });
});

describe('proposal workflow', () => {
  it('proposes, previews and applies an edit', async () => {
    const proposal = await callTool(harness.mcp, token, 'propose_page_edit', {
      key: 'slow-travel-in-spain',
      operation: 'edit',
      description: 'Notes from a slow trip'
    });
    expect(proposal.isError).toBe(false);
    const proposalData = proposal.data as {
      proposalId: string;
      baseRevision: string;
      preview: { fieldChanges: Array<{ field: string; changed: boolean }> };
      note: string;
    };
    expect(proposalData.baseRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalData.note).toContain('Nothing has been written');

    // The proposal alone must not have changed the site.
    expect(site.pages.get('slow-travel-in-spain')?.description).toBe('Notes from the road');

    const applied = await callTool(harness.mcp, token, 'apply_approved_edit', {
      proposal_id: proposalData.proposalId,
      confirm: true
    });
    expect(applied.isError).toBe(false);
    const appliedData = applied.data as { ok: boolean; verified: boolean; revisionAfter: string };
    expect(appliedData.ok).toBe(true);
    expect(appliedData.verified).toBe(true);
    expect(appliedData.revisionAfter).not.toBe(proposalData.baseRevision);
    expect(site.pages.get('slow-travel-in-spain')?.description).toBe('Notes from a slow trip');
  });

  it('refuses to apply the same proposal twice', async () => {
    const proposal = await callTool(harness.mcp, token, 'propose_page_edit', {
      key: 'about-us',
      operation: 'edit',
      description: 'First application wins'
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;

    const first = await callTool(harness.mcp, token, 'apply_approved_edit', { proposal_id: proposalId, confirm: true });
    expect(first.isError).toBe(false);

    const second = await callTool(harness.mcp, token, 'apply_approved_edit', { proposal_id: proposalId, confirm: true });
    expect(second.isError).toBe(true);
    expect(['conflict', 'revision_mismatch']).toContain((second.data as { error: { code: string } }).error.code);
  });

  it('refuses a proposal whose page changed underneath it', async () => {
    const proposal = await callTool(harness.mcp, token, 'propose_page_edit', {
      key: 'launch-announcement',
      operation: 'edit',
      description: 'Scheduled page edit'
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;

    // Simulate a concurrent editor acting directly on the CMS.
    await callTool(harness.mcp, token, 'edit_page', { key: 'launch-announcement', title: 'Launch announcement v2' });

    const applied = await callTool(harness.mcp, token, 'apply_approved_edit', { proposal_id: proposalId, confirm: true });
    expect(applied.isError).toBe(true);
    const error = (applied.data as { error: { code: string; details: Record<string, unknown> } }).error;
    expect(error.code).toBe('revision_mismatch');
    expect(error.details.expectedRevision).not.toBe(error.details.currentRevision);
  });

  it('proposes a creation and applies it', async () => {
    const proposal = await callTool(harness.mcp, token, 'propose_page_edit', {
      key: 'proposed-page',
      operation: 'create',
      title: 'Proposed page',
      content: '# Proposed page\n\nCreated through the proposal flow.\n',
      type: 'draft'
    });
    expect(proposal.isError).toBe(false);
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    expect(site.pages.has('proposed-page')).toBe(false);

    const applied = await callTool(harness.mcp, token, 'apply_approved_edit', { proposal_id: proposalId, confirm: true });
    expect(applied.isError).toBe(false);
    expect(site.pages.get('proposed-page')?.title).toBe('Proposed page');
  });

  it('reports not_found for an unknown proposal id', async () => {
    const result = await callTool(harness.mcp, token, 'apply_approved_edit', {
      proposal_id: 'prop_does_not_exist',
      confirm: true
    });
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('upstream failure handling', () => {
  it('maps an unreachable site to site_unreachable without leaking internals', async () => {
    site.setForcedStatus(undefined);
    const original = site.url;
    const result = await callTool(harness.mcp, token, 'get_page', { key: 'about-us' });
    expect(result.isError).toBe(false);
    void original;

    // Now make the API fail.
    site.setForcedStatus(500);
    const failing = await callTool(harness.mcp, token, 'list_pages', {});
    expect(failing.isError).toBe(true);
    const error = (failing.data as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('upstream_error');
    expect(error.message).not.toContain('api-token-e2e');
    site.setForcedStatus(undefined);
  });

  it('reports site_auth_failed when the upstream rejects the token', async () => {
    site.setForcedStatus(401);
    const result = await callTool(harness.mcp, token, 'list_pages', {});
    expect(result.isError).toBe(true);
    expect((result.data as { error: { code: string } }).error.code).toBe('site_auth_failed');
    site.setForcedStatus(undefined);
  });
});
