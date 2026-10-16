# Bludit compatibility matrix

## What is verified, and what is not

Two kinds of evidence appear below, and they are kept strictly apart.

| Evidence | What it means | Where it comes from |
|---|---|---|
| **Live-verified** | Tested against a real Bludit installation running real PHP, with real `.htaccess` routing and real page storage | `test/live/bludit-live.test.ts`, 24 tests, results in `reports/bludit-live-compatibility.json` |
| **Modelled** | Tested against a faithful re-implementation of the Bludit HTTP API | `test/compat/bludit-editions.test.ts`, results in `reports/bludit-compatibility.json` |

Live results are never inferred from modelled ones. Where only the modelled column
exists for a row, it is marked as such.

## Editions: verified equivalent

The earlier version of this document carried an unverified assumption that Bludit
Community ships the same API plugin as Pro. **That is now verified**, by
byte-comparison of both 3.22.0 source trees:

| File | Community 3.22.0 vs Pro 3.22.0 |
|---|---|
| `bl-plugins/api/plugin.php` | **identical** |
| `bl-kernel/pages.class.php` | **identical** |
| `bl-kernel/pagex.class.php` | **identical** |
| `bl-kernel/functions.php` | **identical** |
| `bl-kernel/security.class.php` | **identical** |
| `bl-kernel/tags.class.php` | **identical** |
| `bl-kernel/categories.class.php` | **identical** |
| `bl-kernel/boot/variables.php` | **identical** |
| `bl-kernel/user.class.php` | **identical** |
| `bl-kernel/users.class.php` | **identical** |

26 entries differ across the whole tree, none of them on any code path this server
exercises:

- Pro-only bundled plugins: `backup-manager`, `comments`, `domain-migrator`,
  `gallery`, `timemachine-x`
- A Pro-only theme, `newsroom`, and a Pro loader file, `bludit.pro.*.php`
- Three unrelated plugin files: `admin/controllers/configure-plugin.php`,
  `version/plugin.php`, `visits-stats/plugin.php`
- Community-only repository furniture: `README.*.md`, `.github/`, `.gitignore`

**Conclusion:** for every endpoint the MCP server calls, Community and Pro 3.22.0
are byte-identical code. The editions differ in bundled features, not in the API
surface. No feature is gated by edition anywhere in this server, and a test
asserts that Community and Pro produce identical tool behaviour.

## Live results

Both installations were created by `scripts/live-bludit-up.sh` in disposable
containers, installed through Bludit's own demo installer, and connected to the
MCP server through the real pairing flow. Generated 2026-10-16.

| | Community | Pro |
|---|---|---|
| Version | 3.22.0 | 3.22.0 |
| Source | GitHub release tarball, tag `3.22.0` | release archive, build 20260510, commit `d5612ed979eeb9ac222a2272aab0c8b97cc09826` |
| Capability: read | ✅ | ✅ |
| Capability: authenticated (write) | ✅ | ✅ |
| Wizard extension detected | ❌ absent (not installed) | ❌ absent (not installed) |
| Declared edition recorded | `community` | `pro` |
| Detected edition | `unknown` | `unknown` |
| `list_pages` | ✅ | ✅ |
| `get_page` | ✅ | ✅ |
| `get_website_settings` | ✅ | ✅ |
| `list_tags` | ✅ | ✅ |
| `list_categories` | ✅ | ✅ |
| `search_pages` | ✅ | ✅ |
| `get_content_summary` | ✅ | ✅ |
| `verify_page_update` | ✅ | ✅ |
| `create_page` | ✅ | ✅ |
| `edit_page` | ✅ | ✅ |
| `propose_page_edit` | ✅ | ✅ |
| `preview_page_changes` | ✅ | ✅ |
| `apply_approved_edit` | ✅ | ✅ |
| Stale approval | correctly refused with `revision_mismatch` | same |

Also live-verified, outside the tool layer:

- `tags` round-trips as a comma-joined **string**, and `pageTags()` normalises it.
- A draft's tag is stored on the page and is **not** tag-indexed.
- A published page's tag **is** tag-indexed.
- A page's revision is stable across reads and changes on edit.
- A missing page returns `not_found`; a traversal key is refused as `invalid_input`.
- A wrong API token is refused as `site_auth_failed`.

## Behaviours discovered by live testing

These were not in any document before the first live run, and the mock had three
of them wrong. All are now reproduced faithfully by the mock.

### 1. `tags` is a string on the wire

`Page::json()` calls `Page::tags(false)`, which returns `implode(',', $tags)`.
The database stores an array; the HTTP API sends a comma-joined string.

Consequences: reading `tags` as an array is a runtime error on a live site, and
the tag list of every page is lost if it is discarded. Both were real bugs here;
`pageTags()` now normalises it in one place, and `pageRevision()` uses the
normalised form so a mock and a live site agree on a revision.

### 2. `category` is `false` when there is no match

`Page::category()` resolves the page's stored category key against the site's
category list and returns `false` when it does not match — which includes a page
stored with a category the site has never defined.

Consequence: `category` must be treated as `string | false`, and the `category`
argument on create/edit is effectively inert unless the category already exists.
The tool description now says so.

### 3. Only published, static and sticky pages are tag-indexed

`$GLOBALS['DB_TAGS_TYPES'] = array('published','static','sticky')` in
`bl-kernel/boot/variables.php`. `Tags::reindex()` skips every other type.

Consequence: `list_tags` will not show a tag that exists only on a draft or a
scheduled page. This is Bludit's rule, not an MCP limitation, and the tool
description discloses it.

## Modelled variants

Retained because they cover feature combinations a live pair cannot cheaply
produce.

| # | Variant | Edition | Version | Wizard | API plugin |
|---|---|---|---|---|---|
| 1 | `community-3.22.0` | Community | 3.22.0 | absent | enabled |
| 2 | `pro-3.22.0` | Pro | 3.22.0 | absent | enabled |
| 3 | `pro-3.22.2` | Pro | 3.22.2 | absent | enabled |
| 4 | `pro-3.22.0-wizard` | Pro | 3.22.0 | **present** | enabled |
| 5 | `community-api-disabled` | Community | 3.22.0 | absent | **disabled** |

| | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Capability: read | ✅ | ✅ | ✅ | ✅ | ❌ |
| Capability: authenticated | ✅ | ✅ | ✅ | ✅ | ❌ |
| Wizard detected | ❌ | ❌ | ❌ | ✅ | ❌ |
| `list_pages` | ✅ | ✅ | ✅ | ✅ | `capability_unavailable` |
| `get_page` | ✅ | ✅ | ✅ | ✅ | `not_found` |
| `create_page` | ✅ | ✅ | ✅ | ✅ | `capability_unavailable` |
| `edit_page` | ✅ | ✅ | ✅ | ✅ | `not_found` |
| propose + apply | ✅ | ✅ | ✅ | ✅ | `not_found` |
| Live confirmation | **✅** | **✅** | ⚠️ modelled | ⚠️ modelled | ⚠️ modelled |

Rows 1 and 2 are modelled *and* live-verified. Rows 3–5 are modelled only, and
say so.

The API-plugin-disabled row is worth reading carefully, because the error codes
are deliberately different:

- `list_pages` and `create_page` report `capability_unavailable`, because those
  endpoints only exist when the plugin is enabled.
- `edit_page` and `get_page` report `not_found`, because Bludit returns 404 for a
  missing page and the plugin's absence is indistinguishable from one.
- `get_site_capabilities` is the tool that resolves the ambiguity, which is why it
  exists.

## Version coverage

| Version | Status |
|---|---|
| 3.22.0 Community | **Live-verified** |
| 3.22.0 Pro | **Live-verified** |
| Later 3.22.x patches | Modelled as behaviourally identical. The API plugin surface is stable across the line as far as the shipped builds show, but this is not live-verified |
| Earlier than 3.22 | **Not supported.** The Wizard plugin declares `compatible: "3.22"`, and the API surface targeted here is the 3.22 line |
| Later than 3.22 | Unknown. `get_site_capabilities` reports what it finds rather than assuming |

## Operation coverage

| Operation | Live | Modelled | Notes |
|---|---|---|---|
| Read site settings | ✅ | ✅ | Needs an authenticated admin token; Bludit's rule |
| List / read pages | ✅ | ✅ | |
| Create page | ✅ | ✅ | Including key derivation from the slug |
| Edit page | ✅ | ✅ | Including key change on slug change |
| Drafts | ✅ | ✅ | |
| Propose, preview, apply, verify | ✅ | ✅ | Including stale-approval refusal |
| Tags and categories | ✅ | ✅ | Official API only; the Wizard API has no equivalent |
| Search | ✅ | ✅ | Server-side only; Bludit has no search endpoint |
| Scheduled pages | ❌ | ✅ | Reads modelled only; the live pages were published or drafts |
| The Wizard extension installed | ❌ | ✅ | Needs the PHP plugin; its pairing endpoint is proposed, not implemented |
| Image / file upload | ❌ | ❌ | Not exposed by any tool |
| Delete page | ❌ | ❌ | Not exposed, by policy |
| Site settings write | ❌ | ❌ | Not exposed |
| User listing | ❌ | ❌ | Not exposed, and not probed |
| Custom fields | ❌ | ❌ | Not exposed |
| Plugin install / upgrade / uninstall | ❌ | ❌ | The PHP plugin's own concern |

## Confirmed limitations

1. **Edition and version cannot be detected over HTTP.** Bludit exposes no such
   endpoint, so `detected` is always `unknown` and `declared` is self-reported.
   Confirmed on both live editions.
2. **`category` is inert unless the category exists.** See above.
3. **Drafts and scheduled pages are not tag-indexed.** See above.
4. **Bludit stores a page's `category` as a key, not a name.** The API returns the
   name only on a successful lookup.
5. **Loopback only.** Both live installations are on `127.0.0.1` over plain http,
   reached through the development allowance. That is a real limitation of this
   evidence: a remote installation over HTTPS is not covered by these runs, and
   the production SSRF policy is what a remote one would exercise.

## How to close the remaining gaps

1. **A remote HTTPS installation.** Run `scripts/live-bludit-up.sh` locally and
   expose it, or install Bludit on a host, then point the live suite at it by
   editing `reports/live-bludit-credentials.json`. This exercises the production
   SSRF policy and TLS.
2. **Later 3.22.x patches.** Download the release, stage it as `site-pro` (or a
   new edition name), and re-run the live suite.
3. **The Wizard extension.** Install `bludit-wizard` into a live container, apply
   the proposed `/api/wizard/pair` contract in PHP, and confirm the HMAC pairing
   path against a real plugin rather than the mock.
4. **Scheduled pages.** Create one with a future date on a live site and assert
   `get_scheduled_pages`.

Credentials for any of these must come through a secure configuration mechanism,
must not be committed, and must not appear in a test log or a report.
