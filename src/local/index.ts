#!/usr/bin/env node
/**
 * Entry point for the local stdio edition.
 *
 * Three rules govern everything in this file:
 *
 *  1. **stdout carries the MCP protocol and nothing else.** Diagnostics are moved
 *     to stderr before the first line can be logged, because one stray write to
 *     stdout would desynchronise the JSON-RPC framing and hang the client.
 *  2. **Configuration failure is immediate and explicit.** A server that starts
 *     with no site and fails on the first tool call is worse than one that refuses
 *     to start and says why.
 *  3. **No secret is ever printed.** Not the API token, not the auth token, not the
 *     configured URL with credentials in it. The startup banner names the site and
 *     nothing else.
 *
 * There is no network listener, no account, no client registration and no token
 * issuance. The process reads stdin, writes stdout, and talks to the one Bludit
 * site it was configured with.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, type LocalConfig } from './config.js';
import { writeDiagnosticsToStderr } from '../shared/log.js';
import { createLocalServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';

interface CliOptions {
  configPath?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new ConfigError(['--config needs a file path.']);
      options.configPath = value;
      index += 1;
    } else if (arg?.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
    } else if (arg !== undefined && arg.trim() !== '') {
      throw new ConfigError([`unrecognised argument: ${arg}`]);
    }
  }
  return options;
}

export function usage(): string {
  return `${SERVER_NAME} ${SERVER_VERSION} — local stdio edition

Usage:
  bludit-wizard-mcp [--config <file>]

Configuration is read from the environment, optionally seeded by a JSON file
(--config, or BLUDIT_CONFIG_FILE). Environment variables win.

  BLUDIT_URL                 Site root, for example https://www.example.com   (required)
  BLUDIT_API_TOKEN           Admin -> Plugins -> API -> Settings               (required)
  BLUDIT_AUTH_TOKEN          Admin -> Users -> your user -> Security -> Token  (writes)
  BLUDIT_WIZARD_API_KEY      Optional Wizard extension key
  BLUDIT_WIZARD_API_BASE     Optional, defaults to <site>/api/wizard
  BLUDIT_SITE_LABEL          Display name, defaults to the hostname
  BLUDIT_ALLOW_INSECURE_URLS Set to "true" to permit http on loopback only
  BLUDIT_CONFIG_FILE         Path to a JSON config file

Diagnostics and the audit trail are written to stderr. The MCP protocol uses
stdout. Credentials are never printed.
`;
}

/**
 * Options for an MCP client, printed by `--help` so the setup guide and this file
 * cannot drift apart.
 */
export function clientConfigSnippet(): string {
  return JSON.stringify(
    { mcpServers: { 'bludit-wizard': { command: 'npx', args: ['-y', 'bludit-wizard-mcp'] } } },
    null,
    2
  );
}

async function main(): Promise<void> {
  // Before anything else: stdout belongs to the protocol from here on.
  writeDiagnosticsToStderr();

  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`[bludit-wizard] ${error.message}\n\n`);
      process.stderr.write(usage());
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (options.help) {
    process.stderr.write(`${usage()}\nA minimal client entry:\n\n${clientConfigSnippet()}\n`);
    return;
  }
  if (options.version) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config: LocalConfig;
  try {
    config = loadConfig({ configPath: options.configPath });
  } catch (error) {
    if (error instanceof ConfigError) {
      // Every problem at once, so the user can fix them in one pass.
      process.stderr.write(`[bludit-wizard] ${error.message}\n\n`);
      process.stderr.write(usage());
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const server = createLocalServer(config);
  const transport = new StdioServerTransport();

  // The banner is on stderr, so it cannot corrupt the protocol stream. It names
  // the site and its capabilities and contains no credential.
  process.stderr.write(
    `[bludit-wizard] ${SERVER_VERSION} serving ${config.label} (${config.baseUrl})` +
      `${config.authToken === '' ? ' [read-only: no BLUDIT_AUTH_TOKEN]' : ''}\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[bludit-wizard] shutting down (${signal})\n`);
    try {
      await server.close();
    } catch {
      // Closing a transport that is already gone is not an error worth reporting.
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // stdin closing is how an MCP client normally ends the session.
  transport.onclose = () => void shutdown('client disconnect');

  await server.connect(transport);
}

// Only run when executed as the entry point — directly (`node dist/local/index.js`),
// or through a thin bin shim that imports this file — so tests can import
// `parseArgs` without starting a server.
const invokedDirectly = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[bludit-wizard] fatal: ${message}\n`);
    process.exit(1);
  });
}
