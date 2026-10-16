/**
 * Bludit API client.
 *
 * Transport rules come from `bl-plugins/api/plugin.php` and are easy to get
 * wrong, so they are stated once here:
 *
 *  - `getMethodInputs()` reads `$_GET` for GET and DELETE, `$_POST` for POST,
 *    and the raw request body for PUT. An empty `$_POST` falls through to the
 *    raw body, which is why a JSON POST also works.
 *  - Therefore the API token travels in the query string for GET/DELETE and in
 *    the JSON body for POST/PUT. The read-only token is `token`; write
 *    operations additionally need `authentication`, the user's auth token.
 *  - Write endpoints require an *enabled admin* account; the plugin logs that
 *    user in server-side for the duration of the request.
 *  - Page keys may be hierarchical (`parent/child`), so path segments are
 *    percent-encoded individually and never allow `..` or NUL.
 */

import { ToolError } from '../shared/errors.js';
import { logger } from '../shared/log.js';
import { safeFetch, SsrfBlockedError, UpstreamTransportError, type UrlPolicy } from '../shared/ssrf.js';
import { stableHashHex } from '../shared/crypto.js';
import type {
  BluditEnvelope,
  BluditPage,
  BluditSettings,
  BluditTaxonomyTerm,
  BluditWriteFields,
  WizardPageList,
  WizardSiteInfo
} from './types.js';

export interface BluditCredentials {
  /** Normalized site base URL, no trailing slash. */
  baseUrl: string;
  apiToken: string;
  authToken: string;
  /** Optional Wizard extension Bearer key. */
  wizardApiKey: string;
  /** Optional Wizard extension base, normally `${baseUrl}/api/wizard`. */
  wizardApiBase: string;
}

export interface BluditClientOptions {
  policy: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Page keys must never escape the site. Mirrors the plugin's own `isValidPageKey`. */
export function assertValidPageKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === '') throw new ToolError('invalid_input', 'A page key is required.');
  if (trimmed.includes('..') || trimmed.includes('\0')) {
    throw new ToolError('invalid_input', 'The page key contains a forbidden sequence.');
  }
  if (trimmed.startsWith('/') || trimmed.length > 512) {
    throw new ToolError('invalid_input', 'The page key is not valid.');
  }
  return trimmed;
}

function encodeKey(key: string): string {
  return assertValidPageKey(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

const API_PLUGIN_MISSING = {
  notFoundAs: 'capability_unavailable' as const,
  notFoundMessage:
    "The Bludit API plugin did not respond. Enable it under Admin -> Plugins -> API, then refresh this site's capabilities."
};

export class BluditClient {
  private readonly credentials: BluditCredentials;
  private readonly options: Required<BluditClientOptions>;

  constructor(credentials: BluditCredentials, options: BluditClientOptions) {
    this.credentials = credentials;
    this.options = {
      policy: options.policy,
      timeoutMs: options.timeoutMs ?? 12_000,
      maxBytes: options.maxBytes ?? 2 * 1024 * 1024
    };
  }

  get baseUrl(): string {
    return this.credentials.baseUrl;
  }

  private url(path: string, query: Record<string, string | number | boolean | undefined> = {}): URL {
    const target = new URL(`${this.credentials.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      target.searchParams.set(key, String(value));
    }
    return target;
  }

  /**
   * Issue a request against the Bludit API and normalize the envelope.
   * Throws `ToolError` with a stable code; never surfaces the upstream body.
   *
   * `notFoundAs` distinguishes "this page does not exist" from "this endpoint
   * does not exist", which is what a site with the API plugin disabled looks
   * like. A 404 on `/api/pages` means the plugin is off, not that a page is
   * missing, and saying so saves the user a pointless search.
   */
  private async call<T>(
    target: URL,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
      requireAuth?: boolean;
      notFoundAs?: 'not_found' | 'capability_unavailable';
      notFoundMessage?: string;
    }
  ): Promise<BluditEnvelope<T>> {
    const { apiToken, authToken } = this.credentials;

    if (init.requireAuth && authToken === '') {
      throw new ToolError('site_auth_failed', 'This site has no user auth token stored; write operations are unavailable.', {
        site: this.credentials.baseUrl
      });
    }

    const url = new URL(target.toString());
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;

    if (init.method === 'GET' || init.method === 'DELETE') {
      url.searchParams.set('token', apiToken);
      if (init.requireAuth) url.searchParams.set('authentication', authToken);
    } else {
      const payload: Record<string, unknown> = { token: apiToken };
      if (init.requireAuth) payload.authentication = authToken;
      Object.assign(payload, init.body ?? {});
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
    }

    let response;
    try {
      response = await safeFetch(url, this.options.policy, {
        method: init.method,
        headers,
        body,
        timeoutMs: this.options.timeoutMs,
        maxBytes: this.options.maxBytes
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new ToolError('invalid_input', `The site URL was rejected: ${error.reason}`);
      }
      if (error instanceof UpstreamTransportError) {
        throw new ToolError('site_unreachable', 'The Bludit site could not be reached.', {
          detail: error.message
        });
      }
      throw error;
    }

    const envelope = (response.json ?? {}) as BluditEnvelope<T>;

    if (response.status === 401 || response.status === 403) {
      throw new ToolError('site_auth_failed', 'The Bludit API rejected the stored credentials.', {
        httpStatus: response.status
      });
    }
    if (response.status === 404) {
      throw new ToolError(
        init.notFoundAs ?? 'not_found',
        init.notFoundMessage ?? 'The Bludit API endpoint or page was not found.',
        { httpStatus: 404 }
      );
    }
    if (response.status >= 500) {
      throw new ToolError('upstream_error', 'The Bludit site returned a server error.', {
        httpStatus: response.status
      });
    }

    // Legacy builds only signal success through the envelope, so check both.
    if (envelope.status !== undefined && envelope.status !== '0' && response.status < 400) {
      throw new ToolError('upstream_error', redactEnvelopeMessage(envelope.message), {
        upstreamStatus: envelope.status
      });
    }
    if (response.status >= 400) {
      throw new ToolError('upstream_error', redactEnvelopeMessage(envelope.message), {
        httpStatus: response.status
      });
    }

    return envelope;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listPages(args: {
    published?: boolean;
    static?: boolean;
    sticky?: boolean;
    draft?: boolean;
    scheduled?: boolean;
    untagged?: boolean;
    pageNumber?: number;
    numberOfItems?: number;
  }): Promise<BluditEnvelope<BluditPage[]>> {
    return this.call<BluditPage[]>(this.url('/api/pages', args), { method: 'GET', ...API_PLUGIN_MISSING });
  }

  async getPage(key: string): Promise<BluditPage> {
    const envelope = await this.call<BluditPage>(this.url(`/api/pages/${encodeKey(key)}`), { method: 'GET' });
    if (!envelope.data) throw new ToolError('not_found', 'The page was not found.', { pageKey: key });
    return envelope.data;
  }

  async getSettings(): Promise<BluditSettings> {
    const envelope = await this.call<BluditSettings>(this.url('/api/settings'), {
      method: 'GET',
      requireAuth: true,
      ...API_PLUGIN_MISSING
    });
    return envelope.data ?? {};
  }

  async listTags(): Promise<BluditTaxonomyTerm[]> {
    const envelope = await this.call<BluditTaxonomyTerm[]>(this.url('/api/tags'), { method: 'GET', ...API_PLUGIN_MISSING });
    return envelope.data ?? [];
  }

  async getTag(key: string): Promise<BluditTaxonomyTerm> {
    const envelope = await this.call<BluditTaxonomyTerm>(this.url(`/api/tags/${encodeURIComponent(key)}`), {
      method: 'GET'
    });
    if (!envelope.data) throw new ToolError('not_found', 'The tag was not found.', { tagKey: key });
    return envelope.data;
  }

  async listCategories(): Promise<BluditTaxonomyTerm[]> {
    const envelope = await this.call<BluditTaxonomyTerm[]>(this.url('/api/categories'), { method: 'GET', ...API_PLUGIN_MISSING });
    return envelope.data ?? [];
  }

  async getCategory(key: string): Promise<BluditTaxonomyTerm> {
    const envelope = await this.call<BluditTaxonomyTerm>(this.url(`/api/categories/${encodeURIComponent(key)}`), {
      method: 'GET'
    });
    if (!envelope.data) throw new ToolError('not_found', 'The category was not found.', { categoryKey: key });
    return envelope.data;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createPage(fields: BluditWriteFields): Promise<BluditPage> {
    const envelope = await this.call<BluditPage>(this.url('/api/pages'), {
      method: 'POST',
      body: serializeWriteFields(fields),
      requireAuth: true,
      ...API_PLUGIN_MISSING
    });
    const key = envelope.data?.key;
    if (!key) {
      throw new ToolError('upstream_error', 'Bludit reported success but returned no page key.');
    }
    return this.getPage(key);
  }

  async editPage(key: string, fields: BluditWriteFields): Promise<{ page: BluditPage; keyChanged: boolean }> {
    const envelope = await this.call<BluditPage>(this.url(`/api/pages/${encodeKey(key)}`), {
      method: 'PUT',
      body: serializeWriteFields(fields),
      requireAuth: true
    });
    const newKey = envelope.data?.key;
    if (!newKey) {
      throw new ToolError('upstream_error', 'Bludit reported success but returned no page key.');
    }
    return { page: await this.getPage(newKey), keyChanged: newKey !== key };
  }

  // -------------------------------------------------------------------------
  // Wizard extension (optional companion plugin)
  // -------------------------------------------------------------------------

  /** True when a Wizard extension base URL and key are configured. */
  get hasWizardExtension(): boolean {
    return this.credentials.wizardApiKey !== '' && this.credentials.wizardApiBase !== '';
  }

  private wizardUrl(path: string): URL {
    if (!this.hasWizardExtension) {
      throw new ToolError('capability_unavailable', 'This site has no Bludit Wizard extension configured.');
    }
    return new URL(`${this.credentials.wizardApiBase}${path}`);
  }

  private async wizardGet<T>(path: string): Promise<T> {
    let response;
    try {
      response = await safeFetch(this.wizardUrl(path), this.options.policy, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.credentials.wizardApiKey}`, accept: 'application/json' },
        timeoutMs: this.options.timeoutMs,
        maxBytes: this.options.maxBytes
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new ToolError('invalid_input', `The Wizard API URL was rejected: ${error.reason}`);
      }
      if (error instanceof UpstreamTransportError) {
        throw new ToolError('capability_unavailable', 'The Bludit Wizard extension did not respond.', {
          detail: error.message
        });
      }
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      throw new ToolError('site_auth_failed', 'The Bludit Wizard extension rejected the configured API key.');
    }
    if (response.status === 404 || response.status === 503) {
      throw new ToolError('capability_unavailable', 'The Bludit Wizard extension is not available on this site.', {
        httpStatus: response.status
      });
    }
    return (response.json ?? {}) as T;
  }

  async wizardSite(): Promise<WizardSiteInfo> {
    return this.wizardGet<WizardSiteInfo>('/site');
  }

  async wizardListPages(): Promise<WizardPageList> {
    return this.wizardGet<WizardPageList>('/pages');
  }

  /**
   * Ask the Wizard extension to prove it received a pairing challenge.
   *
   * Contract (proposed — see docs/PHP_WIZARD_INTEGRATION.md):
   *   GET  {wizardApiBase}/pair?challenge=<base64url>
   *   200  {"ok":true,"challenge":"<echo>","proof":"<base64url HMAC-SHA256>","site":{"title":"…","url":"…"}}
   *   proof = HMAC_SHA256(key = GPT Action API key, message = challenge)
   */
  async wizardPair(challenge: string): Promise<{ ok?: boolean; challenge?: string; proof?: string; error?: string }> {
    return this.wizardGet(`/pair?challenge=${encodeURIComponent(challenge)}`);
  }
}

/**
 * Bludit sanitizes DB-bound values itself, and sanitizing again here would
 * double-encode (`Cats & Dogs` -> `Cats &amp;amp; Dogs`). So this only coerces
 * types and drops undefined fields.
 */
function serializeWriteFields(fields: BluditWriteFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Strip anything that looks like a credential from an upstream message. */
function redactEnvelopeMessage(message: string | undefined): string {
  if (!message) return 'The Bludit API reported an error.';
  return message.replace(/(token|authentication)=[^&\s]+/gi, '$1=[redacted]').slice(0, 300);
}

/**
 * Revision identifier for optimistic concurrency.
 *
 * Hashes the fields a write can change, so an approval based on a stale read
 * is rejected rather than silently overwriting someone else's edit. Bludit's
 * API does not expose `dateModified` or `md5file`, so this is derived from the
 * page payload itself.
 */
export async function pageRevision(page: BluditPage): Promise<string> {
  return stableHashHex({
    key: page.key,
    title: page.title ?? '',
    description: page.description ?? '',
    type: page.type ?? '',
    slug: page.slug ?? '',
    content: page.contentRaw ?? page.content ?? '',
    date: page.dateRaw ?? page.date ?? '',
    uuid: page.uuid ?? '',
    category: page.category ?? '',
    tags: page.tags ?? []
  });
}

/** Log a client-side diagnostic without any credential material. */
export function describeClientFailure(error: unknown): string {
  if (error instanceof ToolError) return `${error.code}: ${error.message}`;
  logger.debug('bludit.client.unexpected', { error: String(error) });
  return 'unknown failure';
}
