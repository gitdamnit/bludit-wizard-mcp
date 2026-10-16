/**
 * Mock Bludit API server.
 *
 * A faithful re-implementation of the semantics in `bl-plugins/api/plugin.php`
 * (Bludit 3.22.x), used to test the MCP tools end to end without a live CMS.
 *
 * The behaviours that matter and are reproduced deliberately:
 *  - the API token is read from the query string for GET/DELETE and from the
 *    JSON body for POST/PUT;
 *  - write endpoints and `GET /api/settings` additionally require
 *    `authentication` to match an enabled admin's user auth token;
 *  - responses carry the legacy `{status:"0"|"1"}` envelope *and* a meaningful
 *    HTTP status;
 *  - `type` drives the list filters, `numberOfItems: -1` returns everything,
 *    and an out-of-range page number yields an empty list;
 *  - a page whose slug changes moves, which changes its key.
 *
 * It also serves the `/.well-known/` pairing file and, optionally, the Bludit
 * Wizard extension endpoints, so the site-connection flow can be tested with
 * and without the extension installed.
 */

import { createServer, type Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface MockPage {
  key: string;
  title: string;
  description: string;
  content: string;
  type: 'published' | 'static' | 'draft' | 'sticky' | 'scheduled';
  slug: string;
  date: string;
  tags: string[];
  category: string;
  uuid: string;
  username: string;
}

export interface RequestLogEntry {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  status: number;
}

export interface MockBluditOptions {
  apiToken?: string;
  authToken?: string;
  wizardApiKey?: string;
  /** When false, the Wizard extension endpoints return 404. Default true. */
  wizardInstalled?: boolean;
  /**
   * Return a structurally valid but cryptographically wrong pairing proof, to
   * model an extension that answers with a proof this server cannot verify.
   */
  wizardProofInvalid?: boolean;
  siteTitle?: string;
  siteDescription?: string;
  pages?: Partial<MockPage>[];
  /** Reject everything with this status. Used for upstream-failure tests. */
  forcedStatus?: number;
}

export interface MockBludit {
  url: string;
  close(): Promise<void>;
  setChallenge(value: string | null): void;
  setForcedStatus(status: number | undefined): void;
  readonly requests: RequestLogEntry[];
  readonly pages: Map<string, MockPage>;
  reset(): void;
}

const DB_DATE = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

export async function startMockBludit(options: MockBluditOptions = {}): Promise<MockBludit> {
  const apiToken = options.apiToken ?? 'api-token-0123456789abcdef';
  const authToken = options.authToken ?? 'auth-token-0123456789abcdef';
  const wizardApiKey = options.wizardApiKey ?? 'wizard-key-0123456789abcdef';
  const wizardInstalled = options.wizardInstalled ?? true;

  const requests: RequestLogEntry[] = [];
  const pages = new Map<string, MockPage>();
  let challenge: string | null = null;
  let forcedStatus = options.forcedStatus;

  const seed = (input: Partial<MockPage>): MockPage => {
    const title = input.title ?? 'Untitled';
    const slug = input.slug ?? slugify(title);
    const page: MockPage = {
      key: input.key ?? slug,
      title,
      description: input.description ?? '',
      content: input.content ?? '',
      type: input.type ?? 'published',
      slug,
      date: input.date ?? '2026-01-01 12:00:00',
      tags: input.tags ?? [],
      category: input.category ?? '',
      uuid: input.uuid ?? randomUUID(),
      username: input.username ?? 'admin'
    };
    pages.set(page.key, page);
    return page;
  };

  for (const page of options.pages ?? []) seed(page);

  const json = (res: import('node:http').ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(body);
  };

  const toApiPage = (page: MockPage): Record<string, unknown> => ({
    key: page.key,
    title: page.title,
    content: page.content,
    contentRaw: page.content,
    description: page.description,
    type: page.type,
    slug: page.slug,
    date: page.date,
    dateRaw: page.date,
    dateUTC: page.date,
    tags: page.tags,
    username: page.username,
    category: page.category,
    uuid: page.uuid,
    permalink: `http://example.invalid/${page.key}`,
    coverImage: false,
    coverImageFilename: false
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams.entries()) query[key] = value;

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null = null;
      if (rawBody.trim() !== '') {
        try {
          const parsed = JSON.parse(rawBody);
          body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
      }

      const log: RequestLogEntry = {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        query,
        body,
        status: 0
      };
      requests.push(log);
      const finish = (status: number, payload: unknown): void => {
        log.status = status;
        json(res, status, payload);
      };

      // ---- public, non-API routes -----------------------------------------
      if (url.pathname === '/.well-known/bludit-wizard-challenge.txt') {
        if (challenge === null) {
          finish(404, { status: '1', message: 'Not found' });
          return;
        }
        log.status = 200;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(challenge);
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        log.status = 404;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      // Forced failures model an API that is down or a plugin that is disabled.
      // Non-API routes such as the ownership file keep working, because that is
      // how a real site with the API plugin switched off behaves.
      if (forcedStatus !== undefined) {
        finish(forcedStatus, { status: '1', message: 'Forced failure for testing.' });
        return;
      }

      // ---- Wizard extension ------------------------------------------------
      if (url.pathname.startsWith('/api/wizard')) {
        if (!wizardInstalled) {
          finish(404, { status: '1', message: 'Unknown endpoint' });
          return;
        }
        const authorization = req.headers.authorization ?? '';
        const provided = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? '';
        if (provided !== wizardApiKey) {
          log.status = 401;
          res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized.' }));
          return;
        }
        if (url.pathname === '/api/wizard/site') {
          finish(200, {
            ok: true,
            site: {
              title: options.siteTitle ?? 'Mock Bludit',
              description: options.siteDescription ?? 'A mock site',
              url: 'http://example.invalid',
              totalPages: pages.size
            }
          });
          return;
        }
        if (url.pathname === '/api/wizard/pair') {
          const providedChallenge = url.searchParams.get('challenge') ?? '';
          if (providedChallenge === '') {
            finish(400, { ok: false, error: 'challenge is required.' });
            return;
          }
          const proof = options.wizardProofInvalid
            ? 'this-proof-does-not-verify'
            : createHmac('sha256', wizardApiKey).update(providedChallenge).digest('base64url');
          finish(200, { ok: true, challenge: providedChallenge, proof, site: { title: options.siteTitle ?? 'Mock Bludit' } });
          return;
        }
        finish(404, { ok: false, error: 'Unknown Wizard endpoint.' });
        return;
      }

      // The plugin reads $_GET for GET/DELETE and the raw body for POST/PUT.
      const useQuery = req.method === 'GET' || req.method === 'DELETE';
      const inputs: Record<string, unknown> = useQuery ? { ...query } : { ...(body ?? {}) };

      if (inputs.token === undefined || inputs.token === '') {
        finish(400, { status: '1', message: 'Missing API token.' });
        return;
      }
      if (inputs.token !== apiToken) {
        finish(401, { status: '1', message: 'Invalid API token.' });
        return;
      }
      const hasWriteAuth = inputs.authentication === authToken;

      // ---- Official Bludit API --------------------------------------------
      const segments = url.pathname.replace(/^\/api\//, '').split('/').filter((part) => part !== '');
      const [resource, key] = segments as [string, string | undefined];

      if (resource === 'settings') {
        if (req.method !== 'GET' || !hasWriteAuth) {
          finish(401, { status: '1', message: 'Access denied or invalid endpoint.' });
          return;
        }
        finish(200, {
          status: '0',
          message: 'Settings.',
          data: {
            title: options.siteTitle ?? 'Mock Bludit',
            description: options.siteDescription ?? 'A mock site',
            language: 'en',
            timezone: 'UTC',
            url: 'http://example.invalid'
          }
        });
        return;
      }

      if (resource === 'tags' || resource === 'categories') {
        const values = [...pages.values()].flatMap((page) =>
          resource === 'tags' ? page.tags : [page.category]
        );
        const terms = [...new Set(values)].filter((value) => value !== '');
        if (key === undefined) {
          finish(200, {
            status: '0',
            message: `List of ${resource}.`,
            data: terms.map((term) => ({ key: term, name: term, description: '' }))
          });
          return;
        }
        if (!terms.includes(key)) {
          finish(404, { status: '1', message: `${resource} not found by the key: ${key}` });
          return;
        }
        const related = [...pages.values()].filter((page) =>
          resource === 'tags' ? page.tags.includes(key) : page.category === key
        );
        finish(200, {
          status: '0',
          message: `Information about the ${resource.slice(0, -1)} and pages related.`,
          data: { key, name: key, description: '', pages: related.map(toApiPage) }
        });
        return;
      }

      if (resource !== 'pages') {
        finish(404, { status: '1', message: 'Unknown endpoint.' });
        return;
      }

      // GET /api/pages
      if (req.method === 'GET' && key === undefined) {
        const filter = (name: string, fallback: boolean): boolean =>
          inputs[name] === undefined ? fallback : String(inputs[name]) === 'true';
        const published = filter('published', true);
        const sticky = filter('sticky', false);
        const draft = filter('draft', false);
        const scheduled = filter('scheduled', false);
        const staticFlag = filter('static', false);
        const untagged = filter('untagged', false);

        const matches = [...pages.values()].filter((page) => {
          if (page.type === 'published' && published) return true;
          if (page.type === 'static' && staticFlag) return true;
          if (page.type === 'sticky' && sticky) return true;
          if (page.type === 'draft' && draft) return true;
          if (page.type === 'scheduled' && scheduled) return true;
          return false;
        });

        const numberOfItems = inputs.numberOfItems === undefined ? 15 : Number(inputs.numberOfItems);
        const pageNumber = Math.max(1, inputs.pageNumber === undefined ? 1 : Number(inputs.pageNumber));
        const slice =
          numberOfItems === -1
            ? matches
            : matches.slice((pageNumber - 1) * numberOfItems, (pageNumber - 1) * numberOfItems + numberOfItems);

        const data = slice
          .filter((page) => (untagged ? page.tags.length === 0 : true))
          .map(toApiPage);

        finish(200, {
          status: '0',
          message: 'List of pages',
          numberOfItems,
          meta: {
            total: matches.length,
            pageNumber,
            pageSize: numberOfItems,
            hasMore: numberOfItems > 0 && pageNumber * numberOfItems < matches.length
          },
          data
        });
        return;
      }

      // GET /api/pages/<key>
      if (req.method === 'GET' && key !== undefined) {
        const page = pages.get(key);
        if (!page) {
          finish(404, { status: '1', message: 'Page not found.' });
          return;
        }
        finish(200, { status: '0', message: `Page filtered by key: ${key}`, data: toApiPage(page) });
        return;
      }

      // POST /api/pages
      if (req.method === 'POST' && key === undefined) {
        if (!hasWriteAuth) {
          finish(401, { status: '1', message: 'Access denied or invalid endpoint.' });
          return;
        }
        const title = String(inputs.title ?? '').trim();
        const content = String(inputs.content ?? '');
        if (title === '' || content === '') {
          finish(400, { status: '1', message: 'Error trying to create the new page.' });
          return;
        }
        const slug = String(inputs.slug ?? '').trim() || slugify(title);
        const parent = String(inputs.parent ?? '').trim();
        let newKey = parent ? `${parent}/${slug}` : slug;
        let suffix = 2;
        while (pages.has(newKey)) {
          newKey = parent ? `${parent}/${slug}-${suffix}` : `${slug}-${suffix}`;
          suffix += 1;
        }
        const type = normalizeType(inputs.type, 'published');
        const page: MockPage = {
          key: newKey,
          title,
          description: String(inputs.description ?? ''),
          content,
          type: type === 'published' && String(inputs.date ?? '') > DB_DATE(new Date()) ? 'scheduled' : type,
          slug,
          date: String(inputs.date ?? DB_DATE(new Date())),
          tags: parseTags(inputs.tags),
          category: String(inputs.category ?? ''),
          uuid: randomUUID(),
          username: 'admin'
        };
        pages.set(page.key, page);
        finish(201, { status: '0', message: 'Page created.', data: toApiPage(page) });
        return;
      }

      // PUT /api/pages/<key>
      if (req.method === 'PUT' && key !== undefined) {
        if (!hasWriteAuth) {
          finish(401, { status: '1', message: 'Access denied or invalid endpoint.' });
          return;
        }
        const page = pages.get(key);
        if (!page) {
          finish(404, { status: '1', message: 'Page not found.' });
          return;
        }
        const next: MockPage = {
          ...page,
          title: inputs.title === undefined ? page.title : String(inputs.title),
          description: inputs.description === undefined ? page.description : String(inputs.description),
          content: inputs.content === undefined || String(inputs.content) === '' ? page.content : String(inputs.content),
          type: inputs.type === undefined ? page.type : normalizeType(inputs.type, page.type),
          slug: inputs.slug === undefined ? page.slug : String(inputs.slug),
          category: inputs.category === undefined ? page.category : String(inputs.category),
          tags: inputs.tags === undefined ? page.tags : parseTags(inputs.tags),
          date: inputs.date === undefined ? page.date : String(inputs.date)
        };

        // A changed slug moves the page, exactly as Bludit's Pages::edit() does.
        const desiredKey = next.slug === page.slug ? page.key : next.slug;
        if (desiredKey !== page.key) {
          if (pages.has(desiredKey)) {
            finish(400, { status: '1', message: 'Error trying to edit the page.' });
            return;
          }
          pages.delete(page.key);
          next.key = desiredKey;
        }
        pages.set(next.key, next);
        finish(200, { status: '0', message: 'Page edited.', data: toApiPage(next) });
        return;
      }

      // DELETE /api/pages/<key>
      if (req.method === 'DELETE' && key !== undefined) {
        if (!hasWriteAuth) {
          finish(401, { status: '1', message: 'Access denied or invalid endpoint.' });
          return;
        }
        if (!pages.has(key)) {
          finish(404, { status: '1', message: 'Page not found.' });
          return;
        }
        pages.delete(key);
        finish(200, { status: '0', message: 'Page deleted.' });
        return;
      }

      finish(401, { status: '1', message: 'Access denied or invalid endpoint.' });
    })().catch(() => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: '1', message: 'Mock failure' }));
      } catch {
        /* response already sent */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    pages,
    setChallenge(value: string | null): void {
      challenge = value;
    },
    setForcedStatus(status: number | undefined): void {
      forcedStatus = status;
    },
    reset(): void {
      requests.length = 0;
      challenge = null;
      forcedStatus = undefined;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function normalizeType(value: unknown, fallback: MockPage['type']): MockPage['type'] {
  const allowed: MockPage['type'][] = ['published', 'static', 'draft', 'sticky', 'scheduled'];
  return allowed.includes(value as MockPage['type']) ? (value as MockPage['type']) : fallback;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter((tag) => tag !== '');
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }
  return [];
}
