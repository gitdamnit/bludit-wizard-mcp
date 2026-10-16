/**
 * Test harness.
 *
 * `createTestHarness` from wrangler builds both Workers and runs them in one
 * workerd instance (Miniflare), wired together by the real Service Binding.
 * That means the tests exercise the actual deployment topology: the resource
 * server validates tokens by calling the authorization server over RPC, exactly
 * as it will in production.
 */

import { createTestHarness, type TestHarness, type WorkerHandle } from 'wrangler';
import type { AnyResponse } from './response.js';

export interface Harness {
  auth: WorkerHandle;
  mcp: WorkerHandle;
  server: TestHarness;
  /**
   * URL of the harness's real local HTTP server. Requests are dispatched to the
   * first Worker whose configured routes match, or to the primary Worker (the
   * authorization server) when none do — which makes it usable from a browser.
   */
  url: string;
  close(): Promise<void>;
}

export const AUTH_ORIGIN = 'http://127.0.0.1:8787';
export const MCP_ORIGIN = 'http://127.0.0.1:8788';
export const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;

/**
 * Two profiles, because the production compatibility flag that CIMD requires
 * (`global_fetch_strictly_public`) also blocks the loopback mock Bludit server.
 *
 *  - `runtime`          — the flag off, so the Workers may reach the loopback
 *                         mock CMS. Used by every CMS-tool test.
 *  - `production-shape` — the flag on, matching deployment. Used to prove the
 *                         production configuration still discovers, authorizes
 *                         and refuses loopback sites.
 */
export type HarnessProfile = 'runtime' | 'production-shape';

const PROFILES: Record<HarnessProfile, { auth: string; mcp: string; schema: string; schemaWorker: string }> = {
  runtime: {
    auth: './wrangler.auth.test.jsonc',
    mcp: './wrangler.mcp.test.jsonc',
    schema: './wrangler.schema.test.jsonc',
    schemaWorker: 'test-schema'
  },
  'production-shape': {
    auth: './wrangler.auth.prodshape.jsonc',
    mcp: './wrangler.mcp.prodshape.jsonc',
    schema: './wrangler.schema.prodshape.jsonc',
    schemaWorker: 'test-schema-prodshape'
  }
};

export async function startHarness(profile: HarnessProfile = 'runtime'): Promise<Harness> {
  const paths = PROFILES[profile];
  const server = createTestHarness({
    workers: [
      { configPath: paths.auth },
      { configPath: paths.mcp },
      { configPath: paths.schema }
    ]
  });

  const { url } = await server.listen();

  // `createTestHarness` does not apply D1 migrations, so run the schema through
  // a test-only Worker that shares the same local database.
  const schemaResponse = await server.getWorker(paths.schemaWorker).fetch('http://schema.test/apply', {
    method: 'POST'
  });
  if (!schemaResponse.ok) {
    throw new Error(`Schema setup failed: ${schemaResponse.status} ${await schemaResponse.text()}`);
  }

  return {
    server,
    url: url.toString().replace(/\/+$/, ''),
    auth: server.getWorker('bludit-wizard-auth'),
    mcp: server.getWorker('bludit-wizard-mcp'),
    async close(): Promise<void> {
      await server.close();
    }
  };
}

/** Minimal cookie jar: enough for the single-session consent flow under test. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: AnyResponse): void {
    const raw = response.headers.getSetCookie?.() ?? [];
    const single = response.headers.get('set-cookie');
    const headers = raw.length > 0 ? raw : single ? [single] : [];
    for (const header of headers) {
      const pair = header.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}
