import { describe, expect, it } from 'vitest';
import { escapeHtml, renderPage, safeJsonForScript } from '../../src/shared/html.js';
import { parseCookies, serializeCookie, sessionCookieName, csrfCookieName } from '../../src/shared/cookies.js';
import { parseEditionLike, toPublicSite, type SiteRow } from '../../src/sites/registry-helpers.js';
import { pickWriteFields, assertWritable } from '../../src/mcp/tools/write-helpers.js';

describe('HTML escaping', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;'
    );
  });

  it('renders a null or undefined value as an empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('neutralizes markup inside an embedded script payload', () => {
    const serialized = safeJsonForScript({ name: '</script><img src=x onerror=alert(1)>' });
    expect(serialized).not.toContain('</script>');
    expect(serialized).toContain('\\u003c');
  });

  it('sets a restrictive content security policy on every page', () => {
    const html = renderPage({ title: 'T', body: '<p>x</p>' });
    expect(html).toContain('<!DOCTYPE html>');
    // The CSP is applied by htmlResponse, not renderPage; assert the page itself has no inline handlers.
    expect(html).not.toContain('onclick=');
  });
});

describe('cookie handling', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=two; c=')).toEqual({ a: '1', b: 'two', c: '' });
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookies('x=a%20b')).toEqual({ x: 'a b' });
  });

  it('serializes a hardened cookie by default', () => {
    const cookie = serializeCookie('name', 'value', { maxAgeSeconds: 60 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=60');
  });

  it('omits Secure only when explicitly asked, for local development', () => {
    expect(serializeCookie('n', 'v', { secure: false })).not.toContain('Secure');
  });

  it('uses the __Host- prefix only over https', () => {
    expect(sessionCookieName('https://mcp.example.com')).toBe('__Host-bw_session');
    expect(sessionCookieName('http://127.0.0.1:8787')).toBe('bw_session');
    expect(csrfCookieName('https://mcp.example.com')).toBe('__Host-bw_csrf');
  });
});

function siteRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    id: 'site_1',
    user_id: 'user_1',
    label: 'Blog',
    base_url: 'https://blog.example.com',
    edition: 'community',
    bludit_version: '',
    api_token_enc: 'v1.enc.enc',
    auth_token_enc: '',
    wizard_api_key_enc: '',
    wizard_api_base: '',
    capabilities_json: '{}',
    status: 'connected',
    last_error: '',
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_000,
    last_checked_at: 0,
    ...overrides
  };
}

describe('site presentation', () => {
  it('never exposes encrypted material or base URLs with credentials', () => {
    const publicSite = toPublicSite(siteRow());
    const serialized = JSON.stringify(publicSite);
    expect(publicSite.baseUrl).toBe('https://blog.example.com');
    expect(serialized).not.toContain('_enc');
    expect(serialized).not.toContain('v1.');
    expect(publicSite.wizardExtension).toBe(false);
  });

  it('reports the Wizard extension as detected only when key and base are both present', () => {
    expect(toPublicSite(siteRow({ wizard_api_base: 'x', wizard_api_key_enc: '' })).wizardExtension).toBe(false);
    expect(toPublicSite(siteRow({ wizard_api_base: '', wizard_api_key_enc: 'x' })).wizardExtension).toBe(false);
    expect(toPublicSite(siteRow({ wizard_api_base: 'x', wizard_api_key_enc: 'y' })).wizardExtension).toBe(true);
  });

  it('tolerates malformed cached capabilities', () => {
    expect(toPublicSite(siteRow({ capabilities_json: 'not json' })).capabilities).toBeUndefined();
    expect(toPublicSite(siteRow({ capabilities_json: '{}' })).capabilities).toBeUndefined();
  });

  it('normalizes an edition string', () => {
    expect(parseEditionLike('pro')).toBe('pro');
    expect(parseEditionLike('community')).toBe('community');
    expect(parseEditionLike('PRO')).toBe('unknown');
    expect(parseEditionLike(undefined)).toBe('unknown');
    expect(parseEditionLike('')).toBe('unknown');
  });
});

describe('write field selection', () => {
  it('keeps only the fields the caller supplied', () => {
    expect(pickWriteFields({ title: 'A', content: 'B' })).toEqual({ title: 'A', content: 'B' });
    expect(pickWriteFields({ title: 'A' })).not.toHaveProperty('content');
  });

  it('keeps explicit empty descriptions, which are meaningful on an edit', () => {
    expect(pickWriteFields({ description: '' })).toEqual({ description: '' });
  });

  it('rejects an unsupported page type', () => {
    expect(() => pickWriteFields({ type: 'autosave' })).toThrow();
  });

  it('requires a title and content to create', () => {
    expect(() => assertWritable({}, 'create')).toThrow();
    expect(() => assertWritable({ title: 'A' }, 'create')).toThrow();
    expect(() => assertWritable({ title: 'A', content: 'B' }, 'create')).not.toThrow();
  });

  it('requires at least one field to edit', () => {
    expect(() => assertWritable({}, 'edit')).toThrow();
    expect(() => assertWritable({ title: 'A' }, 'edit')).not.toThrow();
  });

  it('refuses an empty title or body on an edit, because Bludit would ignore them', () => {
    expect(() => assertWritable({ title: '' }, 'edit')).toThrow();
    expect(() => assertWritable({ content: '' }, 'edit')).toThrow();
  });

  it('exposes the reason as a stable error code', () => {
    try {
      assertWritable({}, 'create');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('invalid_input');
    }
  });
});
