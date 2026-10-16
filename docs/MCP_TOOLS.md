# Tool catalogue

Nineteen tools. Every one declares its scopes up front, and every one is checked
twice: once in the HTTP pre-flight (which produces the `403` step-up challenge)
and once inside the tool callback.

Every tool accepts an optional `site` argument — a site id, an exact label, or a
hostname. With one connected site it may be omitted; with several, omitting it is
an error rather than a guess.

## Classification

Each tool is labelled so a reviewer can see what is actually happening.

| Label | Meaning |
|---|---|
| **CMS read** | A real request to the Bludit HTTP API |
| **CMS write** | A real, mutating request to the Bludit HTTP API |
| **Deterministic** | A pure computation on this server. No model, no inference, reproducible |
| **Service state** | Reads or resolves this service's own records. Touches no CMS |
| **Proposal** | Reads or writes this service's proposal store |

No tool performs inference. This server holds no model provider key and makes no
model calls, by design.

## Service and connection

### `list_sites` · `sites:read` · Service state

Lists the Bludit sites connected to the account: id, label, base URL, declared
edition, connection status, whether the Wizard extension was detected, and
optionally the cached capability report.

Returns no credential, no page content and no settings. Read-only, idempotent.

### `select_site` · `sites:read` · Service state

Resolves a reference (id, exact label, or hostname) to one concrete site and
confirms access. Use it to disambiguate before a write.

Ambiguity is an error listing the candidates, never a silent first match. A wrong
site write is the most damaging failure this service can have.

### `get_site_capabilities` · `sites:read` · Deterministic (with live probes)

Reports what a connected site actually supports:

- whether the official API plugin answers for reads;
- whether authenticated (write) access works;
- which endpoints responded, and for the ones that are not probed, why not;
- whether the optional Bludit Wizard PHP extension is installed;
- the declared edition, and the honest fact that Bludit exposes no version or
  edition over HTTP, so `detected` is always `unknown`.

`refresh: true` re-probes the live site. Every probe is a read; nothing is
written, and `/api/users` and the upload endpoints are never probed.

Example response fragment:

```json
{
  "bluditApi": { "reachable": true, "readOk": true, "authenticatedOk": true },
  "endpoints": {
    "pages": { "supported": true, "note": "GET /api/pages responded successfully." },
    "search": { "supported": false, "note": "No search endpoint exists in the official Bludit API plugin." },
    "users":  { "supported": "documented", "note": "…intentionally not probed: it discloses account records." }
  },
  "wizardExtension": { "available": false, "reason": "No Wizard extension base URL or key is stored for this site." },
  "edition": { "declared": "community", "detected": "unknown", "note": "…not independently verified." }
}
```

## Reading

### `get_website_settings` · `settings:read` · CMS read

Site title, description, language, timezone, URL. Bludit gates `/api/settings`
behind an authenticated admin, so this needs a stored user auth token; the
capability report says so rather than failing opaquely.

### `list_pages` · `pages:read` · CMS read

Filters: `published` (default true), `static`, `sticky`, `draft`, `scheduled`,
`untagged`; plus `pageNumber` and `numberOfItems` (`-1` returns all).

Returns **summaries** — key, title, description, type, slug, date, tags,
category, permalink — plus the API's pagination `meta`.

> Difference from upstream: upstream returned every field of every page,
> including rendered HTML. That fills a model's context with markup nobody asked
> for. Full content is one `get_page` away.

`untagged` is applied to the returned slice, so `meta.total` still counts all
type-matching pages. The response says so.

### `get_page` · `pages:read` · CMS read

One page in full: raw Markdown, rendered HTML, metadata, and a **revision**
identifier.

Two field shapes are worth knowing, both verified against live Bludit 3.22.0 and
both normalised before they reach you:

- `tags` travels as a comma-joined **string** on the wire. It is returned as an
  array here.
- `category` is `false` when the page has no category, **or when its stored
  category is not one the site defines**. It is returned as an empty string here.
  This is why the `category` argument on `create_page` and `edit_page` is inert
  unless the category already exists in Bludit.

The revision is a SHA-256 over the fields a write can change. It is what
`expected_revision`, `propose_page_edit` and `verify_page_update` compare
against. Bludit's API exposes neither `dateModified` nor `md5file`, so the
revision is derived from the page payload rather than read from the CMS.

### `get_drafts` · `pages:read` · CMS read

Convenience wrapper over `list_pages` with `draft` enabled and `numberOfItems: -1`.

### `get_scheduled_pages` · `pages:read` · CMS read

Pages of type `scheduled`, sorted by date, each annotated with `scheduledFor` and
whether that date is still in the future.

### `list_categories` · `pages:read` · CMS read

Category name, description and page count. Bludit reindexes categories after
every page write, so this reflects the last write.

### `list_tags` · `pages:read` · CMS read

Tag name, description and page count.

**Bludit only indexes tags for published, static and sticky pages.** A tag that
exists only on a draft or a scheduled page is stored on the page but never appears
here. That is Bludit's rule (`$GLOBALS['DB_TAGS_TYPES']`), verified against live
Bludit 3.22.0, and the tool's own response says so.

## Deterministic content intelligence

These four compute over CMS data on this server. They call no model and their
output is reproducible byte for byte.

### `search_pages` · `pages:read` · Deterministic

Substring search over key, title, description, slug, tags and category. Set
`include_content: true` to also match page bodies, which fetches each candidate
page individually.

**This is not CMS-side search**, because the official Bludit API has no search
endpoint — the response says so in a `method` field. Results depend on how many
pages were scanned.

`include_content` is capped at 40 pages per call: each page fetched is a separate
subrequest, and a Workers request may make only 50 on the Free plan. Above that
the tool returns `invalid_input` with the reason rather than failing mid-scan.
`scan_limit` without `include_content` goes up to 500.

### `get_content_summary` · `pages:read` · Deterministic

Word count, reading time, heading outline, link and image counts, and warnings
(no description, no headings, under 80 words, template-like braces).

### `get_related_pages` · `pages:read` · Deterministic

Ranks other pages by shared tags, shared category and shared significant title
words, and reports the reasons for each score. Useful for internal linking and
for spotting near-duplicates. No embeddings, no model.

### `preview_page_changes` · `pages:read` · Deterministic

Given proposed field values, returns the field-level changes and a unified diff
of the body, and writes nothing.

This runs the **same code path** `apply_approved_edit` uses, which is the point:
a preview cannot disagree with the applied result.

## Writing

Two paths, deliberately.

### `create_page` · `pages:write` · CMS write

Creates a page and verifies it by reading it back. Requires a non-empty `title`
and `content`. Bludit derives the page key from the slug, or from the title when
no slug is given; the response reports the key that was actually created, which
may differ from what the caller expected.

### `edit_page` · `pages:write` · CMS write

Send only the fields you want to change. Bludit keeps the rest.

- `expected_revision` (optional): refuse the edit if the page changed since that
  revision was read. Optimistic concurrency for callers that want it.
- Bludit moves a page when its slug changes, so the key can change. The response
  reports `keyChanged` and `previousKey`.
- Clearing a page body is **not supported**: Bludit's `Pages::edit()` only
  replaces the body when the value is non-empty, so the tool refuses rather than
  silently doing nothing.

### `propose_page_edit` · `pages:write` · Proposal

Records a short-lived, immutable change proposal. **Writes nothing to the CMS.**

The proposal is bound to the account and the site, pinned to the page's current
revision (`baseRevision`), hashed for integrity, and expires (15 minutes by
default). The response includes the same preview `preview_page_changes` would
produce, and states plainly that nothing has been written.

For `operation: "create"` the `key` argument is the key the caller intends, used
as a conflict check at apply time.

### `apply_approved_edit` · `pages:write` · Proposal + CMS write

Applies a proposal. Refuses when:

| Condition | Error code |
|---|---|
| The proposal is unknown, or belongs to another account or site | `not_found` |
| The proposal already expired | `proposal_expired` |
| The proposal was already applied or rejected | `conflict` |
| The page changed since the proposal was created | `revision_mismatch` |
| The page no longer exists (edit) | `revision_mismatch` |
| A page with that key now exists (create) | `conflict` |

`confirm: true` is required as an explicit acknowledgement.

The proposal is claimed **before** the write so two concurrent applies cannot
both proceed; if the write fails, the claim is released and the proposal can be
retried.

### `verify_page_update` · `pages:read` · CMS read

Reads a page back and checks it against expectations: `expected_revision`,
`expected_title`, `expected_type`, `content_contains`. Reports field-by-field
mismatches with expected and actual values, not a bare pass/fail.

## Not exposed

### `delete_page` — deliberately absent

Present in the upstream stdio server, in the official Bludit API, and in the PHP
Wizard API. Not exposed by any tool here. The reasoning is in `SECURITY.md`; the
short version is that Bludit has no soft delete, so an agent-driven delete is
unrecoverable.

A test asserts that `tools/list` never contains a deletion tool, so this cannot
regress silently.

## Authentication and scope flow

```
POST /mcp (no token)                  → 401  scope="sites:read pages:read"
POST /mcp (read token) tools/call create_page
                                      → 403  scope="sites:read pages:read pages:write"
POST /mcp (write token) tools/call create_page
                                      → 200  result
```

The `403` names the **complete** scope set the operation needs, including the
baseline, because MCP clients treat that list as exhaustive.

`tools/list` always returns all nineteen tools, including ones the current token
cannot use. That is intentional: a hidden tool could never produce the `403`
challenge that lets a client step up, so hiding would make the server harder to
use without making it safer.

## Response shape

Success:

```json
{
  "ok": true,
  "site": { "id": "site_…", "label": "My blog", "baseUrl": "https://example.com" },
  "…": "tool-specific fields"
}
```

Failure (`isError: true`):

```json
{
  "ok": false,
  "error": {
    "code": "revision_mismatch",
    "message": "The page changed after this proposal was created. Re-read it and propose again.",
    "retryable": false,
    "details": { "proposalId": "prop_…", "expectedRevision": "…", "currentRevision": "…" }
  }
}
```

### Error codes

| Code | Meaning | Retryable |
|---|---|---|
| `invalid_input` | The request was malformed or unsafe | no |
| `not_found` | No such page, tag, category, site or proposal for this account | no |
| `ambiguous_site` | The site reference matched more than one site | no |
| `site_unreachable` | The Bludit site could not be reached | yes |
| `site_auth_failed` | The site rejected the stored credentials | no |
| `capability_unavailable` | The endpoint or plugin is not available on this site | no |
| `conflict` | The operation contradicts current state (already applied, key taken) | no |
| `revision_mismatch` | The page changed since it was read | no |
| `proposal_expired` | The proposal or challenge expired | no |
| `forbidden` | The token lacks the scope, or the site failed to prove ownership | no |
| `rate_limited` | Upstream asked us to slow down | yes |
| `upstream_error` | The Bludit site returned an error | yes |
| `internal_error` | Something unexpected; no detail is disclosed | no |

No error message ever contains a credential, a token, an upstream response body,
or a URL carrying a token.

## Examples

Read a page and its revision:

```json
{ "tool": "get_page", "arguments": { "site": "My blog", "key": "about" } }
```

Propose, preview, then apply:

```json
{ "tool": "propose_page_edit", "arguments": {
    "site": "My blog", "key": "about", "operation": "edit",
    "title": "About the team", "content": "# About the team\n\n…" } }

{ "tool": "apply_approved_edit", "arguments": {
    "site": "My blog", "proposal_id": "prop_…", "confirm": true } }
```

Search only titles and descriptions (cheap), then search bodies within one page
of results:

```json
{ "tool": "search_pages", "arguments": { "query": "launch" } }
{ "tool": "search_pages", "arguments": { "query": "walking pace", "include_content": true, "scan_limit": 40 } }
```
