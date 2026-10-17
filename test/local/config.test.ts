/**
 * Configuration tests for the local stdio edition.
 *
 * The point of these tests is that a misconfigured install fails **loudly and
 * immediately**, and that the failure message never contains a credential. A
 * server that starts with no site and fails on the first tool call is the failure
 * mode being designed against.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../../src/local/config.js';
import { parseArgs, usage } from '../../src/local/index.js';

const SECRET_TOKEN = 'API-TOKEN-MUST-NOT-APPEAR-IN-AN-ERROR';
const AUTH_TOKEN = 'AUTH-TOKEN-MUST-NOT-APPEAR-IN-AN-ERROR';

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { BLUDIT_URL: 'https://bludit.example.com', BLUDIT_API_TOKEN: SECRET_TOKEN, ...overrides };
}

describe('local config', () => {
  it('accepts a minimal https configuration', () => {
    const config = loadConfig({ env: env(), warn: () => {} });
    expect(config.baseUrl).toBe('https://bludit.example.com');
    expect(config.apiToken).toBe(SECRET_TOKEN);
    // The label falls back to the hostname so logs identify the site without a
    // second configuration step.
    expect(config.label).toBe('bludit.example.com');
    expect(config.wizardApiBase).toBe('https://bludit.example.com/api/wizard');
  });

  it('normalises a trailing slash and a path prefix', () => {
    const config = loadConfig({
      env: env({ BLUDIT_URL: 'https://example.com/bludit/' }),
      warn: () => {}
    });
    expect(config.baseUrl).toBe('https://example.com/bludit');
  });

  it('reports every missing setting at once, and never the secret', () => {
    let caught: unknown;
    try {
      loadConfig({ env: { BLUDIT_API_TOKEN: SECRET_TOKEN }, warn: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain('BLUDIT_URL is required');
    expect(message).not.toContain(SECRET_TOKEN);
  });

  it('refuses plain http on a public host', () => {
    let caught: unknown;
    try {
      loadConfig({ env: env({ BLUDIT_URL: 'http://bludit.example.com' }), warn: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems.join(' ')).toContain('http');
  });

  it('refuses a loopback address even over https, unless insecurely allowed', () => {
    // Layer one of the SSRF defence: a reserved address is refused outright. The
    // local edition keeps this, even though the user owns the machine, because a
    // config file is exactly the kind of thing that gets pasted from a stranger.
    expect(() => loadConfig({ env: env({ BLUDIT_URL: 'https://127.0.0.1' }), warn: () => {} })).toThrow(
      ConfigError
    );
    const allowed = loadConfig({
      env: env({ BLUDIT_URL: 'http://127.0.0.1:8000', BLUDIT_ALLOW_INSECURE_URLS: 'true' }),
      warn: () => {}
    });
    expect(allowed.baseUrl).toBe('http://127.0.0.1:8000');
  });

  it('warns, but does not fail, when there is no auth token', () => {
    const warnings: string[] = [];
    const config = loadConfig({ env: env(), warn: (message) => warnings.push(message) });
    expect(config.authToken).toBe('');
    expect(warnings.join(' ')).toContain('read-only');
    // The warning must not name a credential that exists, and there is none here.
    expect(warnings.join(' ')).not.toContain(SECRET_TOKEN);
  });

  it('reads a config file, with the environment taking precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bludit-local-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        BLUDIT_URL: 'https://from-file.example.com',
        BLUDIT_API_TOKEN: 'token-from-file',
        BLUDIT_SITE_LABEL: 'From file'
      })
    );
    chmodSync(path, 0o600);

    const fromFile = loadConfig({ env: {}, configPath: path, warn: () => {} });
    expect(fromFile.baseUrl).toBe('https://from-file.example.com');
    expect(fromFile.label).toBe('From file');

    const overridden = loadConfig({
      env: { BLUDIT_URL: 'https://from-env.example.com' },
      configPath: path,
      warn: () => {}
    });
    expect(overridden.baseUrl).toBe('https://from-env.example.com');
    // The file still supplies what the environment did not.
    expect(overridden.label).toBe('From file');
    expect(overridden.apiToken).toBe('token-from-file');
  });

  it('warns when a config file holding a credential is readable by others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bludit-local-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ BLUDIT_URL: 'https://example.com', BLUDIT_API_TOKEN: AUTH_TOKEN }));
    chmodSync(path, 0o644);

    const warnings: string[] = [];
    loadConfig({ env: {}, configPath: path, warn: (message) => warnings.push(message) });
    expect(warnings.join(' ')).toContain('chmod 600');
    // The warning names the file, never the value inside it.
    expect(warnings.join(' ')).not.toContain(AUTH_TOKEN);
  });

  it('reports a missing config file rather than ignoring it', () => {
    expect(() => loadConfig({ env: {}, configPath: '/nonexistent/bludit.json', warn: () => {} })).toThrow(
      ConfigError
    );
  });

  it('rejects malformed JSON with the path but not the contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bludit-local-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, `{ "BLUDIT_API_TOKEN": "${SECRET_TOKEN}", `);
    let caught: unknown;
    try {
      loadConfig({ env: {}, configPath: path, warn: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain('not valid JSON');
    expect((caught as ConfigError).message).not.toContain(SECRET_TOKEN);
  });

  it('parses --config, --help and --version, and rejects the unknown', () => {
    expect(parseArgs(['--config', '/tmp/x.json']).configPath).toBe('/tmp/x.json');
    expect(parseArgs(['--config=/tmp/y.json']).configPath).toBe('/tmp/y.json');
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
    expect(() => parseArgs(['--config'])).toThrow(ConfigError);
    expect(() => parseArgs(['--nonsense'])).toThrow(ConfigError);
  });

  it('documents every variable it actually reads', () => {
    // A usage text that drifts from the code is how a user ends up with a setting
    // they cannot find. These are the variables the loader reads.
    const text = usage();
    for (const name of [
      'BLUDIT_URL',
      'BLUDIT_API_TOKEN',
      'BLUDIT_AUTH_TOKEN',
      'BLUDIT_WIZARD_API_KEY',
      'BLUDIT_WIZARD_API_BASE',
      'BLUDIT_SITE_LABEL',
      'BLUDIT_ALLOW_INSECURE_URLS',
      'BLUDIT_CONFIG_FILE'
    ]) {
      expect(text).toContain(name);
    }
  });
});
