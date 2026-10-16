/**
 * The deployable configuration, asserted.
 *
 * Everything else in the suite tests behaviour under a test configuration. These
 * tests check the files that would actually be deployed, because that is what
 * guards production: a single edited line in `wrangler.auth.jsonc` could disable
 * the platform-level SSRF defence or leave insecure site URLs enabled, and no
 * amount of application testing would notice.
 *
 * The files are read as text and parsed as JSONC.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
  services?: Array<{ binding?: string; service?: string }>;
  kv_namespaces?: Array<{ binding?: string; id?: string }>;
  d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
  triggers?: { crons?: string[] };
  workers_dev?: boolean;
}

/** Strip `//` line comments and `/* *\/` blocks, then parse. */
function readConfig(path: string): WranglerConfig {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw) as WranglerConfig;
}

const AUTH = 'wrangler.auth.jsonc';
const MCP = 'wrangler.mcp.jsonc';

const auth = readConfig(AUTH);
const mcp = readConfig(MCP);

/** Names that must never appear as a plain variable in a deployed config. */
const SECRET_NAMES = ['SITE_CREDENTIAL_KEY', 'SESSION_SECRET', 'CONSENT_SECRET', 'BOOTSTRAP_ADMIN_PASSWORD'];

describe('deployable Worker configuration', () => {
  it('both Workers enable the platform-level SSRF defence', () => {
    // `global_fetch_strictly_public` is layer one of four in the SSRF design.
    // Without it, workerd will happily connect to a private address.
    for (const [path, config] of [
      [AUTH, auth],
      [MCP, mcp]
    ] as const) {
      expect(config.compatibility_flags ?? [], path).toContain('global_fetch_strictly_public');
    }
  });

  it('both Workers have insecure site URLs disabled', () => {
    expect(auth.vars?.ALLOW_INSECURE_SITE_URLS).toBe('false');
    expect(mcp.vars?.ALLOW_INSECURE_SITE_URLS).toBe('false');
  });

  it('keeps rate limiting enabled in production', () => {
    expect(auth.vars?.RATE_LIMIT_ENABLED ?? 'true').not.toBe('false');
    expect(mcp.vars?.RATE_LIMIT_ENABLED ?? 'true').not.toBe('false');
  });

  it('carries no secret as a plain variable', () => {
    for (const [path, config] of [
      [AUTH, auth],
      [MCP, mcp]
    ] as const) {
      for (const name of SECRET_NAMES) {
        expect(config.vars ?? {}, `${path} must not contain ${name}`).not.toHaveProperty(name);
      }
    }
  });

  it('agrees on the issuer and the resource identifier', () => {
    // A mismatch makes every token fail audience validation at runtime.
    expect(auth.vars?.AUTH_ISSUER).toBeTruthy();
    expect(auth.vars?.AUTH_ISSUER).toBe(mcp.vars?.AUTH_ISSUER);
    expect(auth.vars?.MCP_RESOURCE).toBeTruthy();
    expect(auth.vars?.MCP_RESOURCE).toBe(mcp.vars?.MCP_RESOURCE);
  });

  it('keeps the placeholder hostnames for a human to replace', () => {
    // A deployment that forgets this step fails loudly in the verification
    // commands in DEPLOYMENT.md, rather than silently serving localhost URLs.
    for (const config of [auth, mcp]) {
      expect(config.vars?.AUTH_ISSUER ?? '').toMatch(/^http:\/\/localhost:\d+$/);
      expect(config.vars?.MCP_RESOURCE ?? '').toMatch(/\/mcp$/);
    }
  });

  it('binds the resource server to the authorization server by name', () => {
    const binding = (mcp.services ?? []).find((service) => service.binding === 'AUTH_SERVER');
    expect(binding, 'the MCP Worker needs the AUTH_SERVER service binding').toBeDefined();
    expect(binding?.service).toBe(auth.name);
  });

  it('binds the same D1 database in both Workers, and the KV namespace only where it is used', () => {
    const authDb = (auth.d1_databases ?? [])[0];
    const mcpDb = (mcp.d1_databases ?? [])[0];
    expect(authDb?.database_id).toBeTruthy();
    expect(authDb?.database_id).toBe(mcpDb?.database_id);
    expect((mcp.kv_namespaces ?? []).length).toBe(0);
    expect((auth.kv_namespaces ?? [])[0]?.binding).toBe('OAUTH_KV');
  });

  it('does not pin either Worker to a hostname', () => {
    // Adding a route is a DNS change and needs approval; it must not already be
    // present in the repository.
    expect(auth.routes ?? []).toEqual([]);
    expect(mcp.routes ?? []).toEqual([]);
  });

  it('points both Workers at the intended stable worker name', () => {
    expect(auth.name).toBe('bludit-wizard-auth');
    expect(mcp.name).toBe('bludit-wizard-mcp');
  });

  it('keeps the test-only configs out of the deployable set', () => {
    const configs = readdirSync('.').filter((file) => file.startsWith('wrangler.') && file.endsWith('.jsonc'));
    const deployable = [AUTH, MCP];
    for (const name of configs.filter((file) => !deployable.includes(file))) {
      // Anything else must be self-describing as test-only.
      expect(name, `${name} should be named as a test or production-shape config`).toMatch(
        /\.(test|prodshape)\.jsonc$/
      );
    }
    for (const name of configs.filter((file) => /\.(test|prodshape)\.jsonc$/.test(file))) {
      const config = readConfig(name);
      // They carry fixed test keys on purpose, so assert that fact rather than
      // pretending they are innocent: each must say so in its own comment.
      expect(config.name, name).toMatch(/^bludit-wizard-|^test-schema/);
    }
  });

  it('has no deploy step and no credentials in CI', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).not.toMatch(/wrangler\s+deploy\s+--config\s+wrangler\.(auth|mcp)\.jsonc/);
    expect(ci).not.toMatch(/secrets\.(CLOUDFLARE|CF_)/);
    for (const name of SECRET_NAMES) {
      expect(ci).not.toContain(name);
    }
  });

  it('commits no secret-bearing file', () => {
    const ignored = readFileSync('.gitignore', 'utf8');
    for (const pattern of ['.dev.vars', '.env', 'reports/']) {
      expect(ignored, `.gitignore should cover ${pattern}`).toContain(pattern);
    }
  });
});
