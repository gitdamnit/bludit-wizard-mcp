/**
 * MCP request routing helpers.
 *
 * Pure functions, kept out of the Worker entry module so they can be unit tested
 * without loading Workers-only imports.
 */

import { REQUIRED_SCOPES, hasScopes, steppedUpScopes } from '../shared/scopes.js';

/** JSON-RPC methods that name the tool they are calling. */
export function toolNamesFromBody(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const entry = message as { method?: unknown; params?: unknown };
    if (entry.method !== 'tools/call') continue;
    const params = entry.params;
    if (params && typeof params === 'object' && 'name' in params) {
      const name = (params as { name?: unknown }).name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

/**
 * The complete scope set the named tools require: each tool's own scopes plus
 * the resource baseline, deduplicated.
 *
 * This is deliberately the full set rather than the difference. MCP clients treat
 * the scopes named in a `403` challenge as exhaustive and request exactly those,
 * so a partial list would leave the client under-scoped after stepping up.
 */
export function requiredScopesForTools(tools: string[]): string[] {
  const needed = new Set<string>();
  for (const tool of tools) {
    for (const scope of steppedUpScopes(tool)) needed.add(scope);
  }
  return [...needed];
}

/** Whether a token satisfies the baseline every operation needs. */
export function meetsBaseline(scopes: readonly string[]): boolean {
  return hasScopes(scopes, REQUIRED_SCOPES);
}
