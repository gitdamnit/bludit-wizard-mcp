import { describe, expect, it } from 'vitest';
import {
  NON_ACCESS_SCOPES,
  REQUIRED_SCOPES,
  SCOPES,
  TOOL_NAMES,
  TOOL_SCOPES,
  filterGrantableScopes,
  hasScopes,
  scopesForTool,
  steppedUpScopes
} from '../../src/shared/scopes.js';
import { meetsBaseline, requiredScopesForTools, toolNamesFromBody } from '../../src/mcp/routing.js';
import { toErrorPayload, ToolError, redactSecrets } from '../../src/shared/errors.js';
import { safeNext } from '../../src/shared/redirect.js';

describe('scope catalogue', () => {
  it('lists the documented scopes', () => {
    expect([...SCOPES]).toEqual(['sites:read', 'pages:read', 'pages:write', 'settings:read', 'offline_access']);
  });

  it('treats offline_access as non-access', () => {
    expect(NON_ACCESS_SCOPES).toContain('offline_access');
    expect(REQUIRED_SCOPES).toEqual(['sites:read', 'pages:read']);
  });

  it('assigns every tool at least one scope', () => {
    for (const tool of TOOL_NAMES) {
      expect(scopesForTool(tool).length).toBeGreaterThan(0);
    }
  });

  it('never exposes a deletion tool', () => {
    expect(TOOL_NAMES).not.toContain('delete_page');
    expect(Object.keys(TOOL_SCOPES)).not.toContain('delete_page');
  });

  it('gives write tools the write scope and read tools only read scopes', () => {
    for (const tool of ['create_page', 'edit_page', 'propose_page_edit', 'apply_approved_edit']) {
      expect(scopesForTool(tool)).toContain('pages:write');
    }
    for (const tool of ['list_pages', 'get_page', 'search_pages', 'list_tags']) {
      expect(scopesForTool(tool)).not.toContain('pages:write');
    }
  });

  it('returns an empty list for an unknown tool', () => {
    expect(scopesForTool('not_a_tool')).toEqual([]);
  });
});

describe('scope checks', () => {
  it('requires every scope', () => {
    expect(hasScopes(['a', 'b'], ['a'])).toBe(true);
    expect(hasScopes(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(hasScopes(['a'], ['a', 'b'])).toBe(false);
    expect(hasScopes([], [])).toBe(true);
  });

  it('filters out scopes the server cannot grant', () => {
    expect(filterGrantableScopes(['pages:read', 'admin:everything', 'offline_access'])).toEqual([
      'pages:read',
      'offline_access'
    ]);
  });

  it('builds a step-up challenge that includes the baseline', () => {
    const scopes = steppedUpScopes('create_page');
    expect(scopes).toEqual(expect.arrayContaining(['sites:read', 'pages:read', 'pages:write']));
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('checks the baseline for any operation', () => {
    expect(meetsBaseline(['sites:read', 'pages:read'])).toBe(true);
    expect(meetsBaseline(['pages:read'])).toBe(false);
    expect(meetsBaseline(['pages:write'])).toBe(false);
  });
});

describe('tool extraction from a JSON-RPC body', () => {
  it('finds a single tool call', () => {
    expect(toolNamesFromBody({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_page' } })).toEqual([
      'get_page'
    ]);
  });

  it('finds every tool call in a batch', () => {
    expect(
      toolNamesFromBody([
        { method: 'tools/call', params: { name: 'get_page' } },
        { method: 'tools/list' },
        { method: 'tools/call', params: { name: 'edit_page' } }
      ])
    ).toEqual(['get_page', 'edit_page']);
  });

  it('ignores non-tool methods and malformed entries', () => {
    expect(toolNamesFromBody({ method: 'initialize' })).toEqual([]);
    expect(toolNamesFromBody({ method: 'tools/call' })).toEqual([]);
    expect(toolNamesFromBody({ method: 'tools/call', params: { name: 42 } })).toEqual([]);
    expect(toolNamesFromBody(null)).toEqual([]);
    expect(toolNamesFromBody([null, 'x', 3])).toEqual([]);
  });

  it('computes the full required scope set for a batch', () => {
    const scopes = requiredScopesForTools(['list_pages', 'apply_approved_edit']);
    expect(scopes).toEqual(expect.arrayContaining(['sites:read', 'pages:read', 'pages:write']));
  });

  it('requires nothing extra when no tool is being called', () => {
    expect(requiredScopesForTools([])).toEqual([]);
  });
});

describe('error payloads', () => {
  it('maps a tool error to a stable code', () => {
    const payload = toErrorPayload(new ToolError('revision_mismatch', 'stale', { pageKey: 'about' }));
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('revision_mismatch');
    expect(payload.error.retryable).toBe(false);
    expect(payload.error.details).toEqual({ pageKey: 'about' });
  });

  it('marks transient failures retryable', () => {
    expect(toErrorPayload(new ToolError('site_unreachable', 'down')).error.retryable).toBe(true);
    expect(toErrorPayload(new ToolError('rate_limited', 'slow')).error.retryable).toBe(true);
    expect(toErrorPayload(new ToolError('forbidden', 'no')).error.retryable).toBe(false);
  });

  it('never leaks an unexpected error to the caller', () => {
    const payload = toErrorPayload(new Error('SITE_CREDENTIAL_KEY=abc123 leaked in a message'));
    expect(payload.error.code).toBe('internal_error');
    expect(JSON.stringify(payload)).not.toContain('abc123');
  });

  it('redacts credential-shaped substrings', () => {
    expect(redactSecrets('GET /api/pages?token=deadbeef&x=1')).toContain('token=[redacted]');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toContain('[redacted]');
    expect(redactSecrets(`hash ${'a'.repeat(64)}`)).toContain('[redacted-hex64]');
  });
});

describe('redirect target safety', () => {
  it('accepts a same-origin path', () => {
    expect(safeNext('/sites')).toBe('/sites');
    expect(safeNext('/authorize?client_id=x')).toBe('/authorize?client_id=x');
  });

  it('rejects protocol-relative and absolute targets', () => {
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('http://evil.example')).toBeNull();
    expect(safeNext('/\\evil.example')).toBeNull();
  });

  it('rejects empty and relative values', () => {
    expect(safeNext('')).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext(null)).toBeNull();
    expect(safeNext('sites')).toBeNull();
  });
});
