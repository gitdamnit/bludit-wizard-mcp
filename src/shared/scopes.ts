/**
 * Scope catalogue and the tool -> scope map.
 *
 * The authorization server advertises `SCOPES` in its metadata. A protected
 * resource advertises a smaller `REQUIRED_SCOPES` baseline that MCP clients
 * request first; anything more arrives by step-up on a 403 challenge.
 *
 * The MCP handler enforces scopes itself (`TOOL_SCOPES`) — the library
 * advertises what it is told but deliberately does not enforce it, because only
 * the application knows which scopes imply which others.
 */

export const SCOPES = [
  'sites:read',
  'pages:read',
  'pages:write',
  'settings:read',
  'offline_access'
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes that grant no access on their own. */
export const NON_ACCESS_SCOPES: readonly string[] = ['offline_access'];

/**
 * Baseline advertised to clients on the `401` challenge, so a freshly connected
 * client can immediately read its site list and pages.
 */
export const REQUIRED_SCOPES: readonly string[] = ['sites:read', 'pages:read'];

/**
 * Every tool and the scopes it needs. Declared once, used for enforcement,
 * for the 403 challenge payload, and for the publication documentation.
 */
export const TOOL_SCOPES = {
  list_sites: ['sites:read'],
  get_site_capabilities: ['sites:read'],
  select_site: ['sites:read'],
  get_website_settings: ['settings:read'],
  list_pages: ['pages:read'],
  get_page: ['pages:read'],
  search_pages: ['pages:read'],
  list_categories: ['pages:read'],
  list_tags: ['pages:read'],
  get_drafts: ['pages:read'],
  get_scheduled_pages: ['pages:read'],
  get_content_summary: ['pages:read'],
  get_related_pages: ['pages:read'],
  preview_page_changes: ['pages:read'],
  verify_page_update: ['pages:read'],
  create_page: ['pages:write'],
  edit_page: ['pages:write'],
  propose_page_edit: ['pages:write'],
  apply_approved_edit: ['pages:write']
} as const;

export type ToolName = keyof typeof TOOL_SCOPES;

export const TOOL_NAMES = Object.keys(TOOL_SCOPES) as ToolName[];

/** Scopes required for a tool, as a mutable string array for the challenge. */
export function scopesForTool(tool: string): string[] {
  const scopes = (TOOL_SCOPES as Record<string, readonly string[] | undefined>)[tool];
  return scopes ? [...scopes] : [];
}

/** True when `granted` contains every scope in `required`. */
export function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

/** Remove scopes the authorization server cannot grant. */
export function filterGrantableScopes(requested: readonly string[]): Scope[] {
  return requested.filter((scope): scope is Scope => (SCOPES as readonly string[]).includes(scope));
}

/**
 * The scope set a tool operation needs: its own scopes plus the resource
 * baseline. Used to build a complete `insufficient_scope` challenge, because
 * clients treat the returned list as exhaustive.
 */
export function steppedUpScopes(tool: string): string[] {
  const combined = [...REQUIRED_SCOPES, ...scopesForTool(tool)];
  return [...new Set(combined)];
}
