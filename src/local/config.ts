/**
 * Configuration for the local stdio edition.
 *
 * The whole trust model in one file: a local process acts for one user on a site
 * that user configured, on that user's own machine. There is no account, no client
 * registration, no token issuance and no network listener, because there is no
 * second party to authenticate. What the Bludit URL and credentials would be
 * authorized *for* on the hosted service is simply declared here.
 *
 * Values come from environment variables, optionally seeded by a JSON config file.
 * Environment variables win, so a file can hold the non-secret parts (URL, label)
 * while a secret stays in the environment.
 */

import { readFileSync, statSync } from 'node:fs';
import { ToolError } from '../shared/errors.js';
import { checkSiteUrl, normalizeBaseUrl, type UrlPolicy } from '../shared/ssrf.js';

export interface LocalConfig {
  /** Normalised site base URL, no trailing slash. */
  baseUrl: string;
  label: string;
  apiToken: string;
  authToken: string;
  wizardApiKey: string;
  wizardApiBase: string;
  policy: UrlPolicy;
}

/** Every problem found, so a user can fix them in one pass rather than one at a time. */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Bludit Wizard MCP is not configured: ${problems.join(' ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export const CONFIG_FILE_ENV = 'BLUDIT_CONFIG_FILE';

export interface LoadOptions {
  env?: Record<string, string | undefined>;
  /** Path from `--config`, which takes precedence over the environment variable. */
  configPath?: string;
  /** Injected so tests can observe the permission warning. */
  warn?: (message: string) => void;
}

const FILE_KEYS = [
  'BLUDIT_URL',
  'BLUDIT_API_TOKEN',
  'BLUDIT_AUTH_TOKEN',
  'BLUDIT_WIZARD_API_KEY',
  'BLUDIT_WIZARD_API_BASE',
  'BLUDIT_SITE_LABEL',
  'BLUDIT_ALLOW_INSECURE_URLS'
] as const;

/**
 * Read and validate configuration.
 *
 * Throws `ConfigError` listing every problem. Missing configuration must be a
 * clear, immediate failure — never a server that starts and then fails obscurely
 * on the first tool call.
 */
export function loadConfig(options: LoadOptions = {}): LocalConfig {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const problems: string[] = [];

  const fromFile = readConfigFile(options.configPath ?? env[CONFIG_FILE_ENV], warn);
  const read = (key: (typeof FILE_KEYS)[number]): string => {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
    return (fromFile[key] ?? '').trim();
  };

  const rawUrl = read('BLUDIT_URL');
  const rawApiToken = read('BLUDIT_API_TOKEN');

  const allowInsecure = /^(1|true|yes)$/i.test(read('BLUDIT_ALLOW_INSECURE_URLS'));
  const policy: UrlPolicy = { allowInsecure };

  if (rawUrl === '') {
    problems.push(`BLUDIT_URL is required (the site root, for example https://www.example.com).`);
  }
  if (rawApiToken === '') {
    problems.push(
      'BLUDIT_API_TOKEN is required. Find it in Bludit under Admin -> Plugins -> API -> Settings.'
    );
  }

  let baseUrl = '';
  if (rawUrl !== '') {
    const check = checkSiteUrl(rawUrl, policy);
    if (!check.ok || !check.url) {
      problems.push(`BLUDIT_URL was rejected: ${check.reason}`);
      if (rawUrl.startsWith('http://')) {
        problems.push(
          'Plain http is refused unless the host is loopback and BLUDIT_ALLOW_INSECURE_URLS=true. Use https for anything reachable on a network.'
        );
      }
    } else {
      baseUrl = normalizeBaseUrl(check.url);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const label = read('BLUDIT_SITE_LABEL') || new URL(baseUrl).hostname;
  const authToken = read('BLUDIT_AUTH_TOKEN');
  if (authToken === '') {
    // Not an error: reads work with the API token alone. The capability report says
    // so at runtime, and the setup guide explains it.
    warn(
      '[bludit-wizard] BLUDIT_AUTH_TOKEN is not set, so the site is read-only. ' +
        'Add it (Admin -> Users -> your user -> Security -> Token) to create and edit pages.'
    );
  }

  return {
    baseUrl,
    label,
    apiToken: rawApiToken,
    authToken,
    wizardApiKey: read('BLUDIT_WIZARD_API_KEY'),
    wizardApiBase: read('BLUDIT_WIZARD_API_BASE') || `${baseUrl}/api/wizard`,
    policy
  };
}

/** Read the optional JSON config file, warning about world-readable secrets. */
function readConfigFile(path: string | undefined, warn: (message: string) => void): Record<string, string> {
  if (path === undefined || path.trim() === '') return {};

  let raw: string;
  try {
    const mode = statSync(path).mode & 0o777;
    // A config file that holds a credential should not be readable by others.
    if ((mode & 0o077) !== 0) {
      warn(
        `[bludit-wizard] ${path} is readable by other users (mode ${mode.toString(8)}). ` +
          `Run: chmod 600 ${path}`
      );
    }
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError([
      `the config file ${path} could not be read (${error instanceof Error ? error.message : 'unknown error'}).`
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError([
      `the config file ${path} is not valid JSON (${error instanceof Error ? error.message : 'unknown error'}).`
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError([`the config file ${path} must contain a JSON object.`]);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/** Turn a config problem into a tool-error-shaped message for reuse in tests. */
export function configErrorToToolError(error: unknown): ToolError {
  if (error instanceof ConfigError) return new ToolError('invalid_input', error.message);
  return new ToolError('invalid_input', 'The local configuration could not be read.');
}
