/**
 * Local stdio edition — process-level tests.
 *
 * These spawn the **built** server (`dist/local/index.js`) as a child process and
 * speak to it over real stdin/stdout pipes, which is how every MCP client will run
 * it. That makes two things testable that the in-memory suite cannot reach:
 *
 *  1. **stdout purity.** A single `console.log` anywhere in the module graph would
 *     inject a non-JSON line into the protocol stream and desynchronise the client.
 *     Here every line the process writes to stdout is parsed as JSON-RPC.
 *  2. **Startup and shutdown.** The build is exercised, configuration errors exit
 *     non-zero with a message, and closing stdin shuts the process down cleanly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockBludit, type MockBludit } from '../harness/mock-bludit.js';

const API_TOKEN = 'spawn-api-token-112233';
const AUTH_TOKEN = 'spawn-auth-token-445566';
const ENTRY = 'dist/local/index.js';

let site: MockBludit;

interface ChildResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the built server with the given input, and collect both streams. */
function runServer(
  env: Record<string, string>,
  input: string,
  timeoutMs = 30_000
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

function siteEnv(): Record<string, string> {
  return {
    BLUDIT_URL: site.url,
    BLUDIT_API_TOKEN: API_TOKEN,
    BLUDIT_AUTH_TOKEN: AUTH_TOKEN,
    // The mock is loopback over plain http; the URL policy refuses that unless this
    // is set, which is the point of the flag.
    BLUDIT_ALLOW_INSECURE_URLS: 'true'
  };
}

beforeAll(async () => {
  // Build from source so the test proves the *shipped* artefact, not the sources
  // vitest transpiles on the fly.
  if (!existsSync(process.cwd() + '/' + ENTRY)) {
    execFileSync('./node_modules/.bin/tsc', ['-p', 'tsconfig.local-build.json'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    });
  }
  site = await startMockBludit({
    apiToken: API_TOKEN,
    authToken: AUTH_TOKEN,
    siteTitle: 'Spawn Test Blog',
    pages: [
      {
        title: 'Welcome',
        description: 'Hello',
        content: '# Welcome\n\nA page for the process tests.\n',
        type: 'published',
        tags: ['intro']
      }
    ]
  });
}, 180_000);

afterAll(async () => {
  await site.close();
});

describe('local stdio: the built process', () => {
  it('writes nothing but JSON-RPC to stdout, across a full session', async () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'purity', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }
    ];
    const result = await runServer(siteEnv(), requests.map((line) => JSON.stringify(line)).join('\n') + '\n');

    expect(result.code).toBe(0);

    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(line);
      }, `stdout line was not JSON: ${line.slice(0, 200)}`).not.toThrow();
      expect((parsed as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    }

    const responses = lines.map((line) => JSON.parse(line) as { id?: number; result?: unknown });
    const toolList = responses.find((entry) => entry.id === 2)?.result as { tools: { name: string }[] } | undefined;
    expect(toolList?.tools).toHaveLength(19);

    // Diagnostics went to stderr, where they cannot corrupt the stream.
    expect(result.stderr).toContain('[bludit-wizard]');
    // And no credential went to either stream.
    for (const secret of [API_TOKEN, AUTH_TOKEN]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('drives a full read and write flow through a real MCP stdio client', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, ...siteEnv() } as Record<string, string>,
      stderr: 'pipe'
    });
    const client = new Client({ name: 'spawn-client', version: '0.0.0' });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(19);

      const listed = (await client.callTool({ name: 'list_pages', arguments: {} })) as {
        content: { text?: string }[];
      };
      expect(listed.content.map((part) => part.text ?? '').join('')).toContain('Welcome');

      const created = (await client.callTool({
        name: 'create_page',
        arguments: {
          title: 'Written over stdio',
          content: '# Written over stdio\n\nBy a real MCP client.\n',
          type: 'draft',
          confirm: true
        }
      })) as { content: { text?: string }[] };
      const payload = JSON.parse(created.content.map((part) => part.text ?? '').join('')) as {
        ok: boolean;
        verified: boolean;
        key: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.verified).toBe(true);
      expect(payload.key).toBe('written-over-stdio');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('refuses to start with no configuration, and says why, without a credential', async () => {
    const result = await runServer(
      { BLUDIT_URL: '', BLUDIT_API_TOKEN: '', BLUDIT_CONFIG_FILE: '' },
      ''
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BLUDIT_URL is required');
    expect(result.stderr).toContain('BLUDIT_API_TOKEN is required');
    // The usage text points at the fix, on stderr.
    expect(result.stderr).toContain('BLUDIT_AUTH_TOKEN');
    expect(result.stdout).toBe('');
  });

  it('refuses a loopback URL unless the insecure flag is set, and never echoes the token', async () => {
    const result = await runServer(
      { BLUDIT_URL: 'http://127.0.0.1:9', BLUDIT_API_TOKEN: API_TOKEN, BLUDIT_ALLOW_INSECURE_URLS: '' },
      ''
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('BLUDIT_URL was rejected');
    expect(result.stderr).not.toContain(API_TOKEN);
    expect(result.stdout).toBe('');
  });

  it('exits cleanly when the client closes stdin, which is how a session ends', async () => {
    const result = await runServer(siteEnv(), '');
    expect(result.code).toBe(0);
    // A server that hung here would leave an orphan process per client session.
  }, 30_000);

  it('prints help and version on stderr, keeping stdout reserved', async () => {
    const run = (args: string[]): Promise<ChildResult> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('close', (code) => resolve({ stdout, stderr, code }));
      });

    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toBe('');
    expect(version.stderr.trim()).toBe('0.1.0');

    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe('');
    expect(help.stderr).toContain('BLUDIT_URL');
    expect(help.stderr).toContain('--config');
    // The client snippet is printed so the guide and this file cannot drift apart.
    expect(help.stderr).toContain('mcpServers');

    // An unrecognised argument is a usage error, not a crash: the user is told what
    // was wrong and shown the options.
    const bad = await run(['--nonsense']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('unrecognised argument: --nonsense');
    expect(bad.stderr).toContain('BLUDIT_URL');
  }, 30_000);
});
