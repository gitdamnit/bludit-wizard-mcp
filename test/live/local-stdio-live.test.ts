/**
 * Local stdio edition against a **real** Bludit installation.
 *
 * The hermetic suite talks to a mock that reproduces `bl-plugins/api/plugin.php`.
 * This one talks to real Bludit Community and Pro 3.22.0 in disposable Docker
 * containers started by `scripts/live-bludit-up.sh` — real PHP, real `.htaccess`
 * routing, real page storage, real JSON. That is the difference between
 * "mock-verified" and "live-verified", and the mock has been wrong before.
 *
 * Skipped unless `reports/live-bludit-credentials.json` exists, so the default
 * suite stays hermetic. Throwaway containers on loopback, disposable pages only.
 *
 * Note on cleanup: pages created here are **not** deleted afterwards, because the
 * server exposes no delete tool — which is the policy under test, not an oversight.
 * The containers are destroyed instead, which is the reliable way to undo it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface LiveSite {
  edition: 'community' | 'pro';
  baseUrl: string;
  apiToken: string;
  authToken: string;
  bluditVersion: string;
}

const CREDENTIALS = 'reports/live-bludit-credentials.json';
const ENTRY = 'dist/local/index.js';

function loadSites(): LiveSite[] {
  if (!existsSync(CREDENTIALS)) return [];
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS, 'utf8')) as { sites?: LiveSite[] };
    return parsed.sites ?? [];
  } catch {
    return [];
  }
}

const sites = loadSites();

/** A unique page per run, so repeated runs do not collide on a slug. */
const RUN_ID = Date.now().toString(36);

const transports: StdioClientTransport[] = [];

async function connect(site: LiveSite, overrides: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      BLUDIT_URL: site.baseUrl,
      BLUDIT_API_TOKEN: site.apiToken,
      BLUDIT_AUTH_TOKEN: site.authToken,
      // Disposable containers on loopback over plain http. This is the documented
      // escape hatch, and using it here is deliberate.
      BLUDIT_ALLOW_INSECURE_URLS: 'true',
      BLUDIT_SITE_LABEL: `live-${site.edition}`,
      ...overrides
    } as Record<string, string>,
    stderr: 'pipe'
  });
  transports.push(transport);
  const client = new Client({ name: `live-${site.edition}`, version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
  const text = result.content.map((part) => part.text ?? '').join('');
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

afterAll(async () => {
  for (const transport of transports) await transport.close().catch(() => undefined);
});

describe.skipIf(sites.length === 0)('local stdio against a real Bludit site', () => {
  for (const site of sites) {
    describe(`${site.edition} ${site.bluditVersion}`, () => {
      it('registers all nineteen tools and reads the site over stdio', async () => {
        const client = await connect(site);
        try {
          const { tools } = await client.listTools();
          expect(tools).toHaveLength(19);

          const listed = await callJson(client, 'list_pages');
          expect(listed.ok).not.toBe(false);

          // The demo install ships content; a real site with real pages is the
          // thing a mock cannot prove.
          const pages = (listed.pages ?? []) as { key: string }[];
          expect(pages.length).toBeGreaterThan(0);

          const first = pages[0] as { key: string };
          const page = await callJson(client, 'get_page', { key: first.key });
          expect(JSON.stringify(page)).toContain(first.key);

          const capability = await callJson(client, 'get_site_capabilities');
          expect(JSON.stringify(capability)).toMatch(/bluditApi/);
        } finally {
          await client.close();
        }
      }, 120_000);

      it('creates a draft, edits it, and verifies both against the real API', async () => {
        const client = await connect(site);
        const slug = `local-stdio-live-${RUN_ID}`;
        try {
          const created = await callJson(client, 'create_page', {
            title: `Local stdio live ${RUN_ID}`,
            content: '# Live check\n\nWritten by the local stdio edition.\n',
            slug,
            type: 'draft',
            confirm: true
          });
          expect(created.ok).toBe(true);
          expect(created.verified).toBe(true);
          const key = created.key as string;

          const edited = await callJson(client, 'edit_page', {
            key,
            description: `Edited by the live suite at ${RUN_ID}`,
            content: '# Live check\n\nEdited by the local stdio edition.\n',
            confirm: true
          });
          expect(edited.ok).toBe(true);
          expect(edited.verified).toBe(true);

          const readBack = await callJson(client, 'get_page', { key });
          expect(JSON.stringify(readBack)).toContain('Edited by the local stdio edition');
        } finally {
          await client.close();
        }
      }, 120_000);

      it('runs the review-before-write flow against the real API', async () => {
        const client = await connect(site);
        const slug = `local-stdio-proposal-${RUN_ID}`;
        try {
          const created = await callJson(client, 'create_page', {
            title: `Local stdio proposal ${RUN_ID}`,
            content: '# Proposal base\n\nBefore review.\n',
            slug,
            type: 'draft',
            confirm: true
          });
          const key = created.key as string;

          const proposal = await callJson(client, 'propose_page_edit', {
            key,
            operation: 'edit',
            content: '# Proposal base\n\nAfter review.\n'
          });
          expect(proposal.ok).toBe(true);
          expect(typeof proposal.proposalId).toBe('string');

          // Proposing must not have written anything to the real site.
          const beforeApply = await callJson(client, 'get_page', { key });
          expect(JSON.stringify(beforeApply)).not.toContain('After review');

          const applied = await callJson(client, 'apply_approved_edit', {
            proposal_id: proposal.proposalId,
            confirm: true
          });
          expect(applied.ok).toBe(true);
          expect(applied.verified).toBe(true);

          const afterApply = await callJson(client, 'get_page', { key });
          expect(JSON.stringify(afterApply)).toContain('After review');
        } finally {
          await client.close();
        }
      }, 120_000);

      it('never exposes a deletion tool against a real site', async () => {
        const client = await connect(site);
        try {
          const { tools } = await client.listTools();
          for (const tool of tools) {
            expect(tool.name).not.toMatch(/delete|remove|trash/i);
          }
        } finally {
          await client.close();
        }
      }, 60_000);

      it('reads but refuses to write when the user auth token is absent', async () => {
        // The real Bludit API requires `authentication` on write endpoints. What is
        // under test is that the failure is explicit and correctly attributed, not
        // that it is silent or reported as a success.
        const client = await connect(site, { BLUDIT_AUTH_TOKEN: '' });
        try {
          const listed = await callJson(client, 'list_pages');
          expect(JSON.stringify(listed)).toMatch(/pages|ok/);

          const outcome = (await client.callTool({
            name: 'create_page',
            arguments: {
              title: `No auth token ${RUN_ID}`,
              content: 'This must not be created.',
              slug: `no-auth-token-${RUN_ID}`,
              type: 'draft',
              confirm: true
            }
          })) as { content: { text?: string }[]; isError?: boolean };
          const text = outcome.content.map((part) => part.text ?? '').join('');
          expect(text).toMatch(/auth|forbidden|unauthor|permission|denied|invalid/i);
          expect(text).not.toContain('"verified": true');
        } finally {
          await client.close();
        }
      }, 120_000);

      it('fails explicitly on a wrong API token, rather than pretending to read', async () => {
        const client = await connect(site, { BLUDIT_API_TOKEN: 'not-the-real-token' });
        try {
          const outcome = (await client.callTool({ name: 'list_pages', arguments: {} })) as {
            content: { text?: string }[];
            isError?: boolean;
          };
          const text = outcome.content.map((part) => part.text ?? '').join('');
          expect(outcome.isError === true || text.includes('"ok": false') || /error|denied|invalid|token/i.test(text)).toBe(
            true
          );
          // The wrong token must not be echoed back into the response.
          expect(text).not.toContain('not-the-real-token');
        } finally {
          await client.close();
        }
      }, 120_000);
    });
  }
});
