/**
 * Capability detection.
 *
 * The official Bludit API plugin is not identical everywhere: Community and Pro
 * ship the same `bl-plugins/api` in 3.22.x, but a site may have it disabled, and
 * the optional Bludit Wizard PHP extension may or may not be installed. Tools
 * must therefore ask what a site supports instead of assuming.
 *
 * Detection is deliberately conservative:
 *  - Every probe is a read. Nothing is written, and no destructive endpoint is
 *    touched, including when probing.
 *  - A probe that fails for any reason yields `false` plus a short reason. It
 *    never throws, so a partially-working site still produces a useful report.
 *  - Endpoints whose only purpose is to disclose user records are *not* probed.
 *    They are reported as `documented` with an explicit note saying they were
 *    not tested, because enumerating accounts is not a capability check.
 */

import { BluditClient } from './client.js';
import type { BluditEdition, SiteCapabilities } from './capability-types.js';

export async function detectCapabilities(
  client: BluditClient,
  options: { declaredEdition?: BluditEdition } = {}
): Promise<SiteCapabilities> {
  const notes: string[] = [];

  const [pagesProbe, settingsProbe, tagsProbe, categoriesProbe] = await Promise.all([
    probe(() => client.listPages({ numberOfItems: 1, published: true })),
    probe(() => client.getSettings()),
    probe(() => client.listTags()),
    probe(() => client.listCategories())
  ]);

  const wizardProbe: Probe = client.hasWizardExtension
    ? await probeWizard(client)
    : { ok: false, reason: 'No Wizard extension base URL or key is stored for this site.' };

  if (settingsProbe.ok) {
    notes.push('Read + write authentication is working: GET /api/settings requires an authenticated admin.');
  } else if (pagesProbe.ok) {
    notes.push(
      'The read-only API token works, but authenticated endpoints do not. Write tools will fail until a valid user auth token is stored.'
    );
  }

  if (!wizardProbe.ok) {
    notes.push(
      'The Bludit Wizard PHP extension was not detected. Wizard-specific operations are reported as unavailable; core Bludit API tools are unaffected.'
    );
  }

  if (!pagesProbe.ok && !settingsProbe.ok) {
    notes.push('The Bludit API plugin could not be reached at all. Enable it under Admin -> Plugins -> API.');
  }

  notes.push(
    'The official Bludit API has no search endpoint. `search_pages` performs deterministic filtering over the page list on the MCP server; it is not a CMS-side search.'
  );

  return {
    checkedAt: Date.now(),
    edition: {
      declared: options.declaredEdition ?? 'unknown',
      detected: 'unknown',
      note:
        'Bludit does not expose its edition or version over the public HTTP API. `declared` is what the site owner entered when connecting the site; it is not independently verified. See docs/BLUDIT_COMPATIBILITY_MATRIX.md.'
    },
    bluditApi: {
      reachable: pagesProbe.ok || settingsProbe.ok,
      readOk: pagesProbe.ok,
      authenticatedOk: settingsProbe.ok,
      readError: pagesProbe.ok ? '' : pagesProbe.reason,
      authenticatedError: settingsProbe.ok ? '' : settingsProbe.reason
    },
    endpoints: {
      pages: probeResult(pagesProbe, 'GET /api/pages'),
      settings: probeResult(settingsProbe, 'GET /api/settings (requires authentication)'),
      tags: probeResult(tagsProbe, 'GET /api/tags'),
      categories: probeResult(categoriesProbe, 'GET /api/categories'),
      users: {
        supported: 'documented',
        note: 'GET /api/users exists in the official API plugin but is intentionally not probed: it discloses account records, which is not a capability check.'
      },
      files: {
        supported: 'documented',
        note: 'GET/POST /api/files/<page-key> exist in the official API plugin. Requires an existing page and an upload, so they are not probed.'
      },
      images: {
        supported: 'documented',
        note: 'POST /api/images exists in the official API plugin. It is not probed because a probe would perform an upload.'
      },
      search: {
        supported: false,
        note: 'No search endpoint exists in the official Bludit API plugin. Implemented server-side by `search_pages` as deterministic filtering.'
      }
    },
    wizardExtension: {
      available: wizardProbe.ok,
      path: wizardProbe.ok ? '/api/wizard' : '',
      reason: wizardProbe.ok ? '' : wizardProbe.reason,
      capabilities: wizardProbe.ok
        ? ['site', 'pages:list', 'pages:get', 'pages:create', 'pages:update']
        : []
    },
    notes
  };
}

interface Probe {
  ok: boolean;
  reason: string;
}

async function probe(run: () => Promise<unknown>): Promise<Probe> {
  try {
    await run();
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: shortReason(error) };
  }
}

async function probeWizard(client: BluditClient): Promise<Probe> {
  try {
    const result = await client.wizardSite();
    if (result.ok === true) return { ok: true, reason: '' };
    return { ok: false, reason: 'The Wizard extension responded but reported not-ok.' };
  } catch (error) {
    return { ok: false, reason: shortReason(error) };
  }
}

function shortReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = String((error as { code: unknown }).code);
    const message = String((error as { message: unknown }).message);
    return `${code}: ${message}`.slice(0, 200);
  }
  return 'Probe failed.';
}

function probeResult(
  probeResultValue: Probe,
  label: string
): { supported: true | false | 'documented'; note: string } {
  return probeResultValue.ok
    ? { supported: true, note: `${label} responded successfully.` }
    : { supported: false, note: `${label} failed: ${probeResultValue.reason}` };
}
