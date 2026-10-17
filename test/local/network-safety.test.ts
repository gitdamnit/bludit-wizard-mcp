/**
 * Network-safety tests at the layer the local edition actually runs at.
 *
 * The hosted transport gets its strongest SSRF control from a Cloudflare platform
 * feature (`global_fetch_strictly_public`) that **does not exist in Node**. These
 * tests establish what the local edition *does* enforce, so the documented
 * per-transport posture is measured rather than assumed:
 *
 *  - a private/link-local URL is refused at configuration time;
 *  - a redirect that leaves for a private address is refused when it is followed,
 *    so an allowed site cannot be used as a pivot to a metadata endpoint;
 *  - an oversized response is refused rather than buffered;
 *  - and no refusal leaks the API token.
 *
 * What these tests deliberately do **not** claim: that they stop DNS rebinding.
 * A lookup and a connect are two steps, and nothing here closes that gap. See
 * decision D-0006 and `docs/SELF_HOSTED_HTTP.md` §7.2.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalServer } from '../../src/local/server.js';
import { ConfigError, loadConfig } from '../../src/local/config.js';

const API_TOKEN = 'network-safety-token-do-not-print';
const AUTH_TOKEN = 'network-safety-auth-do-not-print';

/** A link-local address: the classic cloud metadata endpoint. */
const METADATA_TARGET = 'http://169.254.169.254/latest/meta-data/';

let redirectingSite: Server;
let redirectingUrl: string;
let oversizedSite: Server;
let oversizedUrl: string;
const requestedPaths: string[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function localConfigFor(baseUrl: string): ReturnType<typeof loadConfig> {
  return loadConfig({
    env: {
      BLUDIT_URL: baseUrl,
      BLUDIT_API_TOKEN: API_TOKEN,
      BLUDIT_AUTH_TOKEN: AUTH_TOKEN,
      BLUDIT_ALLOW_INSECURE_URLS: 'true'
    },
    warn: () => {}
  });
}

async function callThrough(baseUrl: string, name: string): Promise<{ failed: boolean; text: string }> {
  const server = createLocalServer(localConfigFor(baseUrl), {
    audit: { record: async () => {} }
  });
  const client = new Client({ name: 'net-safety', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: {} })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    const text = result.content.map((part) => part.text ?? '').join('');
    return { failed: result.isError === true || text.includes('"ok": false'), text };
  } finally {
    await client.close();
    await server.close();
  }
}

beforeAll(async () => {
  // An otherwise-valid site that answers by redirecting somewhere private.
  redirectingSite = createServer((req, res) => {
    requestedPaths.push(req.url ?? '');
    res.writeHead(302, { Location: METADATA_TARGET });
    res.end();
  });
  redirectingUrl = await listen(redirectingSite);

  // A site that returns far more than the client will accept.
  oversizedSite = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"1","pages":["' + 'A'.repeat(4 * 1024 * 1024) + '"]}');
  });
  oversizedUrl = await listen(oversizedSite);
});

afterAll(async () => {
  await new Promise<void>((resolve) => redirectingSite.close(() => resolve()));
  await new Promise<void>((resolve) => oversizedSite.close(() => resolve()));
});

describe('local edition: URL policy at configuration time', () => {
  it('refuses a link-local site URL outright', () => {
    let caught: unknown;
    try {
      loadConfig({ env: { BLUDIT_URL: METADATA_TARGET, BLUDIT_API_TOKEN: API_TOKEN }, warn: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    // Even with the insecure escape hatch on, a link-local address is not a site.
    expect(() =>
      loadConfig({
        env: {
          BLUDIT_URL: METADATA_TARGET,
          BLUDIT_API_TOKEN: API_TOKEN,
          BLUDIT_ALLOW_INSECURE_URLS: 'true'
        },
        warn: () => {}
      })
    ).toThrow(ConfigError);
  });

  it('does not echo the API token in a refusal', () => {
    try {
      loadConfig({ env: { BLUDIT_URL: 'http://[::ffff:169.254.169.254]/', BLUDIT_API_TOKEN: API_TOKEN }, warn: () => {} });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(API_TOKEN);
    }
  });
});

describe('local edition: network behaviour under a real request', () => {
  it('refuses a redirect that leaves for a private address, so a site cannot be a pivot', async () => {
    const outcome = await callThrough(redirectingUrl, 'list_pages');

    expect(outcome.failed).toBe(true);
    // The refusal names the blocked target rather than silently returning nothing.
    expect(outcome.text).toMatch(/169\.254|reserved|private|blocked|refus/i);
    // The token is never part of an error surface.
    expect(outcome.text).not.toContain(API_TOKEN);
    expect(outcome.text).not.toContain(AUTH_TOKEN);
  });

  it('refuses a response larger than it will accept, rather than buffering it', async () => {
    const outcome = await callThrough(oversizedUrl, 'list_pages');

    expect(outcome.failed).toBe(true);
    expect(outcome.text).toMatch(/exceeded|too large|size|max/i);
    expect(outcome.text).not.toContain(API_TOKEN);
  });

  it('can reach the configured host itself, so the refusals above are about the target', async () => {
    // A sanity check that the two failures are policy, not a broken harness: the
    // redirecting server *was* contacted, and answered.
    expect(requestedPaths.length).toBeGreaterThan(0);
  });
});
