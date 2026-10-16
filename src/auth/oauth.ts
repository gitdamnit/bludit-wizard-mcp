/**
 * Authorization server construction.
 *
 * One `OAuthAuthorizationServer` instance per request, built from the Worker's
 * environment so the issuer, resource identifier and scopes come from
 * configuration rather than from hard-coded hostnames. Construction is cheap:
 * the library holds no per-instance state.
 */

import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { trimBase, type AuthEnv } from '../shared/env.js';
import { SCOPES } from '../shared/scopes.js';

export interface IssuerConfig {
  issuer: string;
  resource: string;
}

export function issuerConfig(env: AuthEnv): IssuerConfig {
  return { issuer: trimBase(env.AUTH_ISSUER), resource: env.MCP_RESOURCE };
}

export function createAuthorizationServer(env: AuthEnv): OAuthAuthorizationServer<AuthEnv> {
  const { issuer, resource } = issuerConfig(env);
  return new OAuthAuthorizationServer<AuthEnv>({
    issuer,
    resources: [resource],
    defaultResource: resource,
    scopesSupported: [...SCOPES],

    // Client ID Metadata Documents: URL-shaped client IDs resolved to a
    // document the client controls. This is the mechanism current MCP clients
    // prefer, because it needs no prior registration.
    clientIdMetadataDocumentEnabled: true,

    // Dynamic Client Registration stays enabled as a fallback for older
    // clients. No software statement is required; the callback below only
    // enforces policy, not identity.
    clientRegistrationEndpoint: '/oauth/register',
    clientRegistrationCallback: async ({ clientMetadata }) => {
      const redirectUris = clientMetadata.redirect_uris;
      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return { code: 'invalid_client_metadata', description: 'redirect_uris is required' };
      }
      // Remote plain-http redirect targets are never acceptable.
      for (const uri of redirectUris) {
        if (typeof uri !== 'string') {
          return { code: 'invalid_redirect_uri', description: 'redirect_uris must be strings' };
        }
        let parsed: URL;
        try {
          parsed = new URL(uri);
        } catch {
          return { code: 'invalid_redirect_uri', description: 'redirect_uris must be absolute URLs' };
        }
        const loopback =
          parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        if (parsed.protocol === 'http:' && !loopback) {
          return { code: 'invalid_redirect_uri', description: 'http redirect URIs are only allowed on loopback' };
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { code: 'invalid_redirect_uri', description: 'redirect URIs must use https' };
        }
      }
      return undefined;
    },

    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    refreshTokenIdleTTL: 30 * 24 * 3600,

    onError: (error) => {
      // Server-side diagnostics only. The wire response stays generic.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'oauth.error',
          code: error.code,
          category: error.internal.category,
          reason: error.internal.reason,
          status: error.status
        })
      );
      return undefined;
    }
  });
}
