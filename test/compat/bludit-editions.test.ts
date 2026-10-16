/**
 * Bludit edition and version compatibility matrix.
 *
 * IMPORTANT — what this file is and is not.
 *
 * It runs the MCP server against faithful *mocks* of the Bludit 3.22.x HTTP API,
 * reproduced from the shipped `bl-plugins/api/plugin.php`. It therefore verifies
 * that the MCP server behaves correctly for each modelled API surface and each
 * documented feature combination. It does **not** verify a live Community or Pro
 * installation: the mocks are labelled as such everywhere, and
 * `docs/BLUDIT_COMPATIBILITY_MATRIX.md` records which cells are mock-verified
 * and which are still pending live confirmation.
 *
 * The variants exist because the differences that matter to this server are not
 * "Community versus Pro" — in 3.22.x both ship the same API plugin — but:
 *   - whether the optional Bludit Wizard PHP extension is installed;
 *   - whether the API plugin is enabled at all;
 *   - whether the site is on an earlier patch release of the same line.
 *
 * The results are written to `reports/bludit-compatibility.json` so the
 * documentation quotes measured output rather than recollection.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockBludit, type MockBludit, type MockBluditOptions } from '../harness/mock-bludit.js';
import { startHarness, type Harness } from '../harness/index.js';
import { accessToken, callTool, createAccount, discover, registerClient } from '../harness/oauth-client.js';
import { connectSiteWithWellKnownFile } from '../harness/site.js';

interface Variant {
  id: string;
  edition: 'community' | 'pro';
  version: string;
  wizardExtension: boolean;
  apiPluginEnabled: boolean;
  options: MockBluditOptions;
}

const VARIANTS: Variant[] = [
  {
    id: 'community-3.22.0',
    edition: 'community',
    version: '3.22.0',
    wizardExtension: false,
    apiPluginEnabled: true,
    options: { siteTitle: 'Community site' }
  },
  {
    id: 'pro-3.22.0',
    edition: 'pro',
    version: '3.22.0',
    wizardExtension: false,
    apiPluginEnabled: true,
    options: { siteTitle: 'Pro site' }
  },
  {
    id: 'pro-3.22.2',
    edition: 'pro',
    version: '3.22.2',
    wizardExtension: false,
    apiPluginEnabled: true,
    options: { siteTitle: 'Pro site, later patch' }
  },
  {
    id: 'pro-3.22.0-wizard',
    edition: 'pro',
    version: '3.22.0',
    wizardExtension: true,
    apiPluginEnabled: true,
    options: { siteTitle: 'Pro site with Wizard', wizardInstalled: true, wizardApiKey: 'variant-wizard-key' }
  },
  {
    id: 'community-api-disabled',
    edition: 'community',
    version: '3.22.0',
    wizardExtension: false,
    apiPluginEnabled: false,
    options: { siteTitle: 'Community site, API plugin off', forcedStatus: 404 }
  }
];

interface VariantResult {
  id: string;
  edition: string;
  version: string;
  wizardExtension: boolean;
  apiPluginEnabled: boolean;
  declaredEditionRecorded: string;
  detectedEdition: string;
  capabilityReadOk: boolean;
  capabilityAuthenticatedOk: boolean;
  wizardDetected: boolean;
  listPages: string;
  getPage: string;
  createPage: string;
  editPage: string;
  proposeAndApply: string;
}

let harness: Harness;
let token: string;
const results: VariantResult[] = [];
const mocks = new Map<string, MockBludit>();

beforeAll(async () => {
  harness = await startHarness();
  const account = await createAccount(harness.auth, 'compat@example.test');
  const as = await discover(harness.mcp, harness.auth);
  const client = await registerClient(harness.auth, as, 'http://127.0.0.1:7688/callback');
  const tokens = await accessToken(harness.auth, account, {
    as,
    client,
    scope: 'sites:read pages:read pages:write settings:read offline_access'
  });
  token = tokens.access_token;

  for (const variant of VARIANTS) {
    const mock = await startMockBludit({
      apiToken: `api-${variant.id}`,
      authToken: `auth-${variant.id}`,
      pages: [
        { title: 'Home', content: '# Home\n\nWelcome.\n', type: 'published', tags: ['home'] },
        { title: 'Existing page', content: '# Existing\n\nBody.\n', type: 'published' }
      ],
      ...variant.options
    });
    mocks.set(variant.id, mock);

    const outcome = await connectSiteWithWellKnownFile(
      harness.auth,
      account,
      {
        siteUrl: mock.url,
        apiToken: `api-${variant.id}`,
        authToken: `auth-${variant.id}`,
        wizardApiKey: variant.wizardExtension ? 'variant-wizard-key' : '',
        label: variant.id,
        edition: variant.edition
      },
      (challenge) => mock.setChallenge(challenge)
    );
    if (!outcome.ok) {
      throw new Error(`Variant ${variant.id} failed to connect: ${outcome.html.slice(0, 400)}`);
    }
  }
}, 600_000);

afterAll(async () => {
  await mkdir('reports', { recursive: true });
  await writeFile('reports/bludit-compatibility.json', `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  for (const mock of mocks.values()) await mock.close();
  await harness?.close();
});

/** Outcome label for a tool call, using the stable error code when it fails. */
function outcomeOf(result: { isError: boolean; data: Record<string, unknown> | null }): string {
  if (!result.isError) return 'success';
  const error = result.data?.error as { code?: string } | undefined;
  return `error:${error?.code ?? 'unknown'}`;
}

describe.each(VARIANTS)('variant $id', (variant) => {
  it('connects and reports capabilities that match the modelled site', async () => {
    const capabilities = await callTool(harness.mcp, token, 'get_site_capabilities', {
      site: variant.id,
      refresh: true
    });
    expect(capabilities.isError).toBe(false);

    const data = capabilities.data as {
      capabilities: {
        bluditApi: { readOk: boolean; authenticatedOk: boolean };
        wizardExtension: { available: boolean };
        edition: { declared: string; detected: string };
      };
    };

    expect(data.capabilities.bluditApi.readOk).toBe(variant.apiPluginEnabled);
    expect(data.capabilities.bluditApi.authenticatedOk).toBe(variant.apiPluginEnabled);
    expect(data.capabilities.wizardExtension.available).toBe(variant.wizardExtension);
    expect(data.capabilities.edition.declared).toBe(variant.edition);
    // Detection never guesses: Bludit exposes no version or edition over HTTP.
    expect(data.capabilities.edition.detected).toBe('unknown');

    const listPages = await callTool(harness.mcp, token, 'list_pages', { site: variant.id, numberOfItems: -1 });
    const getPage = await callTool(harness.mcp, token, 'get_page', { site: variant.id, key: 'home' });
    const createPage = await callTool(harness.mcp, token, 'create_page', {
      site: variant.id,
      title: `Created on ${variant.id}`,
      content: '# Created\n\nBody.\n',
      type: 'draft'
    });
    const editPage = await callTool(harness.mcp, token, 'edit_page', {
      site: variant.id,
      key: 'existing-page',
      description: `Edited on ${variant.id}`
    });

    const proposal = await callTool(harness.mcp, token, 'propose_page_edit', {
      site: variant.id,
      key: 'existing-page',
      operation: 'edit',
      title: `Proposed on ${variant.id}`
    });
    let proposeAndApply = proposal.isError ? outcomeOf(proposal) : 'proposed';
    if (!proposal.isError) {
      const applied = await callTool(harness.mcp, token, 'apply_approved_edit', {
        site: variant.id,
        proposal_id: (proposal.data as { proposalId: string }).proposalId,
        confirm: true
      });
      proposeAndApply = applied.isError ? `apply ${outcomeOf(applied)}` : 'success';
    }

    results.push({
      id: variant.id,
      edition: variant.edition,
      version: variant.version,
      wizardExtension: variant.wizardExtension,
      apiPluginEnabled: variant.apiPluginEnabled,
      declaredEditionRecorded: data.capabilities.edition.declared,
      detectedEdition: data.capabilities.edition.detected,
      capabilityReadOk: data.capabilities.bluditApi.readOk,
      capabilityAuthenticatedOk: data.capabilities.bluditApi.authenticatedOk,
      wizardDetected: data.capabilities.wizardExtension.available,
      listPages: outcomeOf(listPages),
      getPage: outcomeOf(getPage),
      createPage: outcomeOf(createPage),
      editPage: outcomeOf(editPage),
      proposeAndApply
    });

    if (variant.apiPluginEnabled) {
      expect(outcomeOf(listPages)).toBe('success');
      expect(outcomeOf(getPage)).toBe('success');
      expect(outcomeOf(createPage)).toBe('success');
      expect(outcomeOf(editPage)).toBe('success');
      expect(proposeAndApply).toBe('success');
    } else {
      // With the API plugin off, every CMS read and write fails with a code the
      // caller can act on rather than an opaque internal error.
      expect(outcomeOf(listPages)).toBe('error:capability_unavailable');
      expect(outcomeOf(createPage)).toBe('error:capability_unavailable');
      expect(outcomeOf(editPage)).toBe('error:not_found');
      expect(proposeAndApply).toBe('error:not_found');
    }
  });
});

describe('cross-edition consistency', () => {
  it('gives Community and Pro identical tool behaviour for the same API surface', () => {
    const community = results.find((result) => result.id === 'community-3.22.0');
    const pro = results.find((result) => result.id === 'pro-3.22.0');
    expect(community).toBeDefined();
    expect(pro).toBeDefined();

    const behaviour = (result: VariantResult): Record<string, unknown> => ({
      capabilityReadOk: result.capabilityReadOk,
      capabilityAuthenticatedOk: result.capabilityAuthenticatedOk,
      wizardDetected: result.wizardDetected,
      listPages: result.listPages,
      getPage: result.getPage,
      createPage: result.createPage,
      editPage: result.editPage,
      proposeAndApply: result.proposeAndApply
    });

    // The only difference permitted between editions is the edition the user declared.
    expect(behaviour(pro as VariantResult)).toEqual(behaviour(community as VariantResult));
    expect(community?.declaredEditionRecorded).toBe('community');
    expect(pro?.declaredEditionRecorded).toBe('pro');
  });

  it('gives identical behaviour across patch releases of the same line', () => {
    const first = results.find((result) => result.id === 'pro-3.22.0');
    const later = results.find((result) => result.id === 'pro-3.22.2');
    expect(first?.listPages).toBe(later?.listPages);
    expect(first?.createPage).toBe(later?.createPage);
    expect(first?.proposeAndApply).toBe(later?.proposeAndApply);
  });

  it('reports the Wizard extension as the only capability difference when it is installed', () => {
    const without = results.find((result) => result.id === 'pro-3.22.0');
    const withWizard = results.find((result) => result.id === 'pro-3.22.0-wizard');
    expect(without?.wizardDetected).toBe(false);
    expect(withWizard?.wizardDetected).toBe(true);
    expect(withWizard?.listPages).toBe(without?.listPages);
    expect(withWizard?.createPage).toBe(without?.createPage);
  });

  it('records a result for every variant', () => {
    expect(results).toHaveLength(VARIANTS.length);
  });
});
