/**
 * Live tests against real Bludit installations.
 *
 * Everything else in this repository tests against a mock of the Bludit API.
 * These tests talk to real Bludit Community and real Bludit Pro, installed by
 * `scripts/live-bludit-up.sh` into disposable containers. They are the only
 * evidence in the project of live compatibility, and they are deliberately kept
 * out of the hermetic suite.
 *
 * Run:
 *   scripts/live-bludit-up.sh          # Community, and Pro when PRO_ZIP is set
 *   npm run test:live
 *
 * With no credentials file the whole file skips, so nothing here can be
 * mistaken for a default-suite result. Results are written to
 * `reports/bludit-live-compatibility.json`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BluditClient, pageRevision, pageTags } from '../../src/bludit/client.js';
import { detectCapabilities } from '../../src/bludit/capabilities.js';
import { ToolError } from '../../src/shared/errors.js';
import { startHarness, type Harness } from '../harness/index.js';
import { accessToken, callTool, createAccount, discover, registerClient, type ClientCredentials } from '../harness/oauth-client.js';
import { requestChallenge, submitSite } from '../harness/site.js';

interface LiveSite {
  edition: 'community' | 'pro';
  baseUrl: string;
  apiToken: string;
  authToken: string;
  bluditVersion: string;
  obtainedAt: string;
}

const CREDENTIALS_PATH = 'reports/live-bludit-credentials.json';

function loadSites(): LiveSite[] {
  if (!existsSync(CREDENTIALS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as { sites?: LiveSite[] };
    return (parsed.sites ?? []).filter((site) => site.baseUrl && site.apiToken);
  } catch {
    return [];
  }
}

const sites = loadSites();

/** A live result record, for the compatibility report. */
interface LiveResult {
  edition: string;
  baseUrl: string;
  bluditVersion: string;
  readOk: boolean;
  authenticatedOk: boolean;
  wizardExtension: boolean;
  declaredEditionRecorded: string;
  detectedEdition: string;
  operations: Record<string, string>;
}

const liveResults: LiveResult[] = [];

/**
 * Publish the pairing challenge into the container's web root.
 *
 * This is the plugin-free ownership proof the production flow uses, done with
 * `docker exec` because a container filesystem is not reachable any other way
 * from a test.
 */
function publishChallenge(edition: string, challenge: string): void {
  execFileSync(
    'docker',
    ['exec', '-i', `bludit-live-${edition}`, 'sh', '-c', 'mkdir -p /var/www/html/.well-known && cat > /var/www/html/.well-known/bludit-wizard-challenge.txt'],
    { input: challenge }
  );
}

function outcomeOf(result: { isError: boolean; data: Record<string, unknown> | null }): string {
  if (!result.isError) return 'success';
  const error = result.data?.error as { code?: string } | undefined;
  return `error:${error?.code ?? 'unknown'}`;
}

describe.skipIf(sites.length === 0)('live Bludit installations', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 300_000);

  afterAll(async () => {
    mkdirSync('reports', { recursive: true });
    writeFileSync(
      'reports/bludit-live-compatibility.json',
      `${JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Live results. See docs/BLUDIT_COMPATIBILITY_MATRIX.md.', results: liveResults }, null, 2)}\n`
    );
    await harness?.close();
  });

  describe.each(sites)('$edition $bluditVersion', (site) => {
    const client = (): BluditClient =>
      new BluditClient(
        {
          baseUrl: site.baseUrl,
          apiToken: site.apiToken,
          authToken: site.authToken,
          wizardApiKey: '',
          wizardApiBase: `${site.baseUrl}/api/wizard`
        },
        // The containers are on loopback over plain http, which is exactly what
        // the development flag permits. Production refuses this.
        { policy: { allowInsecure: true } }
      );

    it('reports what the live API actually supports', async () => {
      const capabilities = await detectCapabilities(client(), { declaredEdition: site.edition });

      expect(capabilities.bluditApi.reachable, 'the API plugin should answer').toBe(true);
      expect(capabilities.bluditApi.readOk).toBe(true);
      expect(capabilities.bluditApi.authenticatedOk, 'the admin auth token should work').toBe(true);
      expect(capabilities.endpoints.pages?.supported).toBe(true);
      expect(capabilities.endpoints.tags?.supported).toBe(true);
      expect(capabilities.endpoints.categories?.supported).toBe(true);
      // Bludit exposes no version or edition over HTTP. This is the finding that
      // the compatibility matrix is built on, now confirmed against a live site.
      expect(capabilities.edition.detected).toBe('unknown');

      liveResults.push({
        edition: site.edition,
        baseUrl: site.baseUrl,
        bluditVersion: site.bluditVersion,
        readOk: capabilities.bluditApi.readOk,
        authenticatedOk: capabilities.bluditApi.authenticatedOk,
        wizardExtension: capabilities.wizardExtension.available,
        declaredEditionRecorded: capabilities.edition.declared,
        detectedEdition: capabilities.edition.detected,
        operations: {}
      });
    });

    it('reads pages and settings over the real API', async () => {
      const api = client();
      const envelope = await api.listPages({ numberOfItems: -1, published: true, draft: true, static: true });
      expect(Array.isArray(envelope.data)).toBe(true);
      expect(envelope.meta?.total).toBeGreaterThan(0);

      const settings = await api.getSettings();
      expect(typeof settings.title).toBe('string');
      expect((settings.title as string).length).toBeGreaterThan(0);

      const tags = await api.listTags();
      const categories = await api.listCategories();
      expect(Array.isArray(tags)).toBe(true);
      expect(Array.isArray(categories)).toBe(true);
    });

    it('reads one page in full, and the revision is stable', async () => {
      const api = client();
      const list = await api.listPages({ numberOfItems: -1 });
      const first = list.data?.[0];
      expect(first, 'the demo install should have at least one page').toBeDefined();

      const page = await api.getPage(first?.key as string);
      expect(page.key).toBe(first?.key);
      expect(typeof page.title).toBe('string');
      // A real Bludit returns the raw Markdown alongside the parsed HTML.
      expect(page.contentRaw).toBeDefined();

      const again = await api.getPage(page.key);
      expect(await pageRevision(again)).toBe(await pageRevision(page));
    });

    it('round-trips tags as the comma-joined string the API actually sends', async () => {
      const api = client();
      const title = `Live tag page ${Date.now()}`;

      const created = await api.createPage({
        title,
        content: `# ${title}\n`,
        type: 'draft',
        tags: 'live-test, another tag'
      });
      expect(created.key).toBeTruthy();
      expect(created.type).toBe('draft');

      // The wire format, asserted deliberately: `Page::json()` returns
      // `implode(',', $tags)`, so this is a string, not an array.
      expect(typeof created.tags).toBe('string');
      expect(created.tags).toBe('live-test,another tag');
      // And the normaliser turns it back into usable tags.
      expect(pageTags(created)).toEqual(['live-test', 'another tag']);
    });

    it('does not index a draft tag, because Bludit only indexes published, static and sticky pages', async () => {
      const api = client();
      const tag = `draft-only-${Date.now()}`;
      const created = await api.createPage({
        title: `Live draft tag ${Date.now()}`,
        content: '# draft\n',
        type: 'draft',
        tags: tag
      });
      expect(pageTags(created)).toEqual([tag]);

      // Stored on the page, absent from the index. This is Bludit's rule, not an
      // MCP limitation, and it is recorded in docs/BLUDIT_COMPATIBILITY_MATRIX.md.
      const tags = await api.listTags();
      expect(tags.map((entry) => entry.key)).not.toContain(tag);
    });

    it('indexes a published page tag', async () => {
      const api = client();
      const tag = `published-tag-${Date.now()}`;
      await api.createPage({
        title: `Live published tag ${Date.now()}`,
        content: '# published\n',
        type: 'published',
        tags: tag
      });

      const tags = await api.listTags();
      expect(tags.map((entry) => entry.key)).toContain(tag);
    });

    it('edits a page and moves the revision', async () => {
      const api = client();
      const created = await api.createPage({
        title: `Live edit page ${Date.now()}`,
        content: '# edit\n',
        type: 'draft'
      });

      const before = await pageRevision(created);
      const edited = await api.editPage(created.key, { description: 'Edited by the live test' });
      expect(edited.page.description).toBe('Edited by the live test');
      expect(await pageRevision(edited.page)).not.toBe(before);
    });

    it('refuses a write with a stale revision, on the real API', async () => {
      const api = client();
      const title = `Live revision guard ${Date.now()}`;
      const created = await api.createPage({ title, content: '# guard\n', type: 'draft' });
      const stale = await pageRevision(created);

      await api.editPage(created.key, { description: 'first change' });

      // The client itself does not enforce this; the MCP tool does. Here we prove
      // the revision genuinely changes, which is what the guard relies on.
      const current = await pageRevision(await api.getPage(created.key));
      expect(current).not.toBe(stale);
    });

    it('reports not_found for a page that does not exist, and refuses a traversal key', async () => {
      const api = client();
      await expect(api.getPage(`missing-${Date.now()}`)).rejects.toMatchObject({ code: 'not_found' });
      await expect(api.getPage('../../etc/passwd')).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('rejects a request with the wrong API token', async () => {
      const wrong = new BluditClient(
        { baseUrl: site.baseUrl, apiToken: 'not-the-token', authToken: site.authToken, wizardApiKey: '', wizardApiBase: '' },
        { policy: { allowInsecure: true } }
      );
      try {
        await wrong.listPages({});
        throw new Error('should have been rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).code).toBe('site_auth_failed');
      }
    });

    // -----------------------------------------------------------------------
    // The full MCP path, against the live site
    // -----------------------------------------------------------------------

    describe('through the MCP server', () => {
      let token: string;
      let siteId: string;

      beforeAll(async () => {
        const as = await discover(harness.mcp, harness.auth);
        const account = await createAccount(harness.auth, `live-${site.edition}-${Date.now()}@example.test`);
        const clientCredentials: ClientCredentials = await registerClient(
          harness.auth,
          as,
          `http://127.0.0.1:${site.edition === 'pro' ? 7721 : 7720}/callback`
        );
        const tokens = await accessToken(harness.auth, account, {
          as,
          client: clientCredentials,
          scope: 'sites:read pages:read pages:write settings:read offline_access'
        });
        token = tokens.access_token;

        const { challenge } = await requestChallenge(harness.auth, account, {
          label: `Live ${site.edition}`,
          baseUrl: site.baseUrl
        });
        publishChallenge(site.edition, challenge);

        const outcome = await submitSite(harness.auth, account, challenge, {
          siteUrl: site.baseUrl,
          apiToken: site.apiToken,
          authToken: site.authToken,
          label: `Live ${site.edition}`,
          edition: site.edition
        });
        if (!outcome.ok) throw new Error(`Live connect failed: ${outcome.html.slice(0, 600)}`);
        siteId = outcome.siteId as string;
      }, 300_000);

      it('connects the real site and lists it', async () => {
        const result = await callTool(harness.mcp, token, 'list_sites', { include_capabilities: true });
        expect(result.isError).toBe(false);
        const data = result.data as { count: number; sites: Array<{ declaredEdition: string }> };
        expect(data.count).toBe(1);
        expect(data.sites[0]?.declaredEdition).toBe(site.edition);
        // No credential may appear anywhere in the response.
        expect(result.raw).not.toContain(site.apiToken);
        expect(result.raw).not.toContain(site.authToken);
      });

      it('runs the read, write and review operations end to end', async () => {
        const record = liveResults.find((entry) => entry.edition === site.edition);
        const operations: Record<string, string> = {};

        const listPages = await callTool(harness.mcp, token, 'list_pages', { site: siteId, numberOfItems: -1 });
        operations.list_pages = outcomeOf(listPages);
        const pageKey = (listPages.data as { pages: Array<{ key: string }> }).pages[0]?.key as string;

        const getPage = await callTool(harness.mcp, token, 'get_page', { site: siteId, key: pageKey });
        operations.get_page = outcomeOf(getPage);
        const revision = (getPage.data as { revision: string }).revision;

        operations.get_website_settings = outcomeOf(
          await callTool(harness.mcp, token, 'get_website_settings', { site: siteId })
        );
        operations.list_tags = outcomeOf(await callTool(harness.mcp, token, 'list_tags', { site: siteId }));
        operations.list_categories = outcomeOf(await callTool(harness.mcp, token, 'list_categories', { site: siteId }));
        operations.search_pages = outcomeOf(
          await callTool(harness.mcp, token, 'search_pages', { site: siteId, query: 'bludit' })
        );
        operations.get_content_summary = outcomeOf(
          await callTool(harness.mcp, token, 'get_content_summary', { site: siteId, key: pageKey })
        );
        operations.verify_page_update = outcomeOf(
          await callTool(harness.mcp, token, 'verify_page_update', { site: siteId, key: pageKey, expected_revision: revision })
        );

        const created = await callTool(harness.mcp, token, 'create_page', {
          site: siteId,
          title: `MCP live page ${Date.now()}`,
          content: '# MCP live page\n\nCreated through the MCP server.\n',
          type: 'draft'
        });
        operations.create_page = outcomeOf(created);
        const createdKey = (created.data as { key: string }).key;

        operations.edit_page = outcomeOf(
          await callTool(harness.mcp, token, 'edit_page', {
            site: siteId,
            key: createdKey,
            description: 'Edited through the MCP server'
          })
        );

        const proposed = await callTool(harness.mcp, token, 'propose_page_edit', {
          site: siteId,
          key: createdKey,
          operation: 'edit',
          title: `MCP live page (reviewed) ${Date.now()}`
        });
        operations.propose_page_edit = outcomeOf(proposed);
        const proposalId = (proposed.data as { proposalId: string }).proposalId;

        operations.preview_page_changes = outcomeOf(
          await callTool(harness.mcp, token, 'preview_page_changes', {
            site: siteId,
            key: createdKey,
            title: 'A previewed title'
          })
        );

        operations.apply_approved_edit = outcomeOf(
          await callTool(harness.mcp, token, 'apply_approved_edit', {
            site: siteId,
            proposal_id: proposalId,
            confirm: true
          })
        );

        // A stale approval must be refused against the live site too.
        const doomed = await callTool(harness.mcp, token, 'propose_page_edit', {
          site: siteId,
          key: createdKey,
          operation: 'edit',
          description: 'will be stale'
        });
        await callTool(harness.mcp, token, 'edit_page', { site: siteId, key: createdKey, description: 'moved on' });
        operations.stale_approval_refused = outcomeOf(
          await callTool(harness.mcp, token, 'apply_approved_edit', {
            site: siteId,
            proposal_id: (doomed.data as { proposalId: string }).proposalId,
            confirm: true
          })
        );

        if (record) record.operations = operations;

        for (const [operation, outcome] of Object.entries(operations)) {
          if (operation === 'stale_approval_refused') {
            expect(outcome, operation).toBe('error:revision_mismatch');
          } else {
            expect(outcome, `${site.edition} ${operation}`).toBe('success');
          }
        }
      }, 300_000);
    });
  });
});
