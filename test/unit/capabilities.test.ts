import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/bludit/capabilities.js';
import type { BluditClient } from '../../src/bludit/client.js';
import { ToolError } from '../../src/shared/errors.js';

/**
 * A stand-in for `BluditClient` that answers each probe independently, so the
 * capability report can be tested for every combination of working and broken
 * endpoints without a live site.
 */
function fakeClient(failures: Record<string, ToolError | Error> = {}, wizardConfigured = false): BluditClient {
  const attempt = (name: string): void => {
    const failure = failures[name];
    if (failure) throw failure;
  };
  return {
    hasWizardExtension: wizardConfigured,
    listPages: async () => {
      attempt('pages');
      return { status: '0', data: [] };
    },
    getSettings: async () => {
      attempt('settings');
      return { title: 'T' };
    },
    listTags: async () => {
      attempt('tags');
      return [];
    },
    listCategories: async () => {
      attempt('categories');
      return [];
    },
    wizardSite: async () => {
      attempt('wizard');
      return { ok: true, site: { title: 'T' } };
    }
  } as unknown as BluditClient;
}

describe('capability detection', () => {
  it('reports everything working on a healthy site', async () => {
    const capabilities = await detectCapabilities(fakeClient(), { declaredEdition: 'community' });
    expect(capabilities.bluditApi.reachable).toBe(true);
    expect(capabilities.bluditApi.readOk).toBe(true);
    expect(capabilities.bluditApi.authenticatedOk).toBe(true);
    expect(capabilities.endpoints.pages?.supported).toBe(true);
    expect(capabilities.endpoints.settings?.supported).toBe(true);
    expect(capabilities.endpoints.tags?.supported).toBe(true);
    expect(capabilities.endpoints.categories?.supported).toBe(true);
  });

  it('records the declared edition but never fabricates a detected one', async () => {
    const declared = await detectCapabilities(fakeClient(), { declaredEdition: 'pro' });
    expect(declared.edition.declared).toBe('pro');
    expect(declared.edition.detected).toBe('unknown');

    const undeclared = await detectCapabilities(fakeClient());
    expect(undeclared.edition.declared).toBe('unknown');
  });

  it('explains that the official API has no search endpoint', async () => {
    const capabilities = await detectCapabilities(fakeClient());
    expect(capabilities.endpoints.search?.supported).toBe(false);
    expect(capabilities.notes.join(' ')).toContain('no search endpoint');
  });

  it('marks user and upload endpoints as documented, not probed', async () => {
    const capabilities = await detectCapabilities(fakeClient());
    expect(capabilities.endpoints.users?.supported).toBe('documented');
    expect(capabilities.endpoints.files?.supported).toBe('documented');
    expect(capabilities.endpoints.images?.supported).toBe('documented');
    expect(capabilities.endpoints.users?.note).toContain('not probed');
  });

  it('survives a completely unreachable API without throwing', async () => {
    const down = new ToolError('site_unreachable', 'The Bludit site could not be reached.');
    const capabilities = await detectCapabilities(
      fakeClient({ pages: down, settings: down, tags: down, categories: down })
    );
    expect(capabilities.bluditApi.reachable).toBe(false);
    expect(capabilities.bluditApi.readOk).toBe(false);
    expect(capabilities.endpoints.pages?.supported).toBe(false);
    expect(capabilities.endpoints.pages?.note).toContain('site_unreachable');
    expect(capabilities.notes.join(' ')).toContain('could not be reached at all');
  });

  it('distinguishes read-only access from authenticated access', async () => {
    const capabilities = await detectCapabilities(
      fakeClient({ settings: new ToolError('site_auth_failed', 'rejected the stored credentials') })
    );
    expect(capabilities.bluditApi.readOk).toBe(true);
    expect(capabilities.bluditApi.authenticatedOk).toBe(false);
    expect(capabilities.notes.join(' ')).toContain('Write tools will fail');
  });

  it('reports the Wizard extension as unavailable when none is configured', async () => {
    const capabilities = await detectCapabilities(fakeClient({}, false));
    expect(capabilities.wizardExtension.available).toBe(false);
    expect(capabilities.wizardExtension.reason).toContain('No Wizard extension');
    expect(capabilities.notes.join(' ')).toContain('was not detected');
  });

  it('reports the Wizard extension as available when it answers', async () => {
    const capabilities = await detectCapabilities(fakeClient({}, true));
    expect(capabilities.wizardExtension.available).toBe(true);
    expect(capabilities.wizardExtension.path).toBe('/api/wizard');
    expect(capabilities.wizardExtension.capabilities).toContain('pages:update');
  });

  it('reports the Wizard extension as unavailable when the probe fails', async () => {
    const capabilities = await detectCapabilities(
      fakeClient({ wizard: new ToolError('capability_unavailable', 'not installed') }, true)
    );
    expect(capabilities.wizardExtension.available).toBe(false);
    expect(capabilities.wizardExtension.reason).toContain('capability_unavailable');
  });

  it('survives a non-ToolError probe failure', async () => {
    const capabilities = await detectCapabilities(fakeClient({ tags: new Error('boom') }));
    expect(capabilities.endpoints.tags?.supported).toBe(false);
    expect(capabilities.endpoints.tags?.note).toContain('Probe failed');
  });
});
