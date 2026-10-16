# Bludit Wizard PHP plugin — integration notes

Read-only inspection of the PHP plugin, and the contracts this server needs from
it. **The PHP project was not modified.** Where an interface this server would
like does not exist, the contract is proposed here rather than invented in code.

## Source inspected

| | |
|---|---|
| Artefact | `bludit-wizard-1.0.4-rc1.zip` (unpacked to a scratch directory) |
| Location | `/home/evan/Projects/Bludit-Wizard/` — outside this repository |
| Plugin directory | `wizard/` |
| Class | `pluginWizard extends Plugin` |
| Size | `plugin.php` 38,692 bytes / 957 lines |
| Files | `plugin.php`, `metadata.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `css/wizard.css`, `js/wizard.js`, `languages/en.json` |
| Declared version | 1.0.4, release candidate, `compatible: "3.22"` |
| Declared author | Evan Zellner |
| Licence | MIT |

The release candidate is explicitly labelled *pending live validation* in its own
`metadata.json` and `CHANGELOG.md`. Nothing here treats it as verified.

Nothing was copied into this repository: no `.env` file, no API keys, tokens or
cookies, no production configuration, no website content, no database files, no
server-specific paths, and none of the plugin source tree. Only interface facts
are recorded.

## What the plugin does

A native Bludit admin plugin that adds a **Wizard** sidebar item with an
AI-assisted workflow: pick a task, pick a page, write an instruction, review the
generated result in an editable area, then press **Apply this change**. It also
exposes a separate Bearer-authenticated HTTP API for Custom GPT Actions.

## Authentication and authorization

Two completely separate credentials, which is deliberate:

| Credential | Setting field | Used for |
|---|---|---|
| **LLM provider key** | `apiKey` | Outbound calls to the configured model provider |
| **GPT Action API key** | `wizardApiKey` | Inbound Custom GPT Action requests |

The admin UI is protected by Bludit's own session plus an explicit CSRF check:
`adminController()` verifies `tokenCSRF` with `hash_equals()` against
`$security->getTokenCSRF()`. The AJAX script receives the token through
`window.BW_CONFIG`.

The public API requires `Authorization: Bearer <wizardApiKey>`, compared with
`hash_equals()`, and falls back to an `X-Bludit-Wizard-Key` header for hosts that
strip `Authorization`. If no `wizardApiKey` is configured the API answers `503`
rather than serving anything.

## Custom GPT Action API — endpoints as implemented

Base path `/api/wizard`, dispatched from `beforeAll()` by path suffix.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/wizard/site` | — | `{ok, site:{title, description, url, totalPages}}` |
| GET | `/api/wizard/pages` | — | `{ok, count, pages:[{key, title, description, type, slug, permalink}]}` — capped at 200 |
| GET | `/api/wizard/pages/{key}` | — | `{ok, page:{key, title, description, type, slug, permalink, content, contentRaw}}` |
| POST | `/api/wizard/pages` | `{title, content, type?, description?, slug?, tags?, category?, parent?}` | `201 {ok, message, page}` |
| PUT | `/api/wizard/pages/{key}` | `{confirm:true, title?, description?, content?, type?, slug?}` | `{ok, message, page}` |
| DELETE | `/api/wizard/pages/{key}` | `{confirm:true}` | `{ok, message}` |

Status codes used: `200`, `201`, `400`, `401` (with `WWW-Authenticate: Bearer`),
`403`, `404`, `405`, `500`, `503`.

Field rules observed in the implementation:

- `title` and `content` are required on create; an empty value is a `400`.
- `type` is restricted to `published`, `draft`, `static`, `sticky`, `scheduled`;
  an unknown value silently falls back to `draft` on create, or to the page's
  current type on update.
- `tags` accepts a string or array and is normalised to a comma-separated string.
- `PUT` and `DELETE` require `confirm: true`; omission is a `400`.
- Errors are `{ok:false, error:"<message>"}`, never an exception trace.

Notably absent: pagination on `/pages` (a fixed 200-row cap), any capability
endpoint, any revision or ETag, and any search.

## CMS operations used

The plugin calls Bludit's own API rather than touching page files:

- `buildPage($key)` to read a page
- `createPage($args)` to create
- `editPage($args)` to update
- `deletePage($key)` to delete
- `$pages->exists()`, `$pages->getDB(true)` for existence and enumeration
- `$site->title()`, `description()`, `url()` for site facts
- `Session::set/get/remove('username')` — see the administrator-identity note
- `User`, `$users->keys()` to find an enabled administrator
- `Sanitize::html()` on input
- `PATH_PLUGINS` scan to list installed plugin directories

### Administrator identity during create

`createPage()` obtains the page author from `Session::get('username')`. A GPT
Action request has no browser session, so `createPageAsAdministrator()`
temporarily sets the session username to the first enabled administrator, calls
`createPage()`, and restores the previous value in a `finally` block. This is
documented in the plugin's own changelog against 1.0.3.

**This is the single most fragile part of the PHP API**, and this server does not
depend on it: the official Bludit API plugin does the same thing internally via
`new Login()->setLogin(...)`, and the hosted MCP server uses the official API.

## Model configuration and inference

`dbFields` defaults:

| Field | Default |
|---|---|
| `provider` | `openai` (`openai` \| `ollama` \| `compatible`) |
| `baseUrl` | `https://api.openai.com/v1` |
| `model` | `gpt-4o-mini` |
| `apiKey` | empty |
| `temperature` | `0.3` |
| `maxTokens` | `2500` |
| `systemPrompt` | "You are Bludit Wizard, a careful CMS assistant…" |

Requests go to `{baseUrl}/chat/completions` with `Authorization: Bearer {apiKey}`
when a key is set, a `90s` timeout and a `15s` connect timeout, via cURL. The
response is read from `choices[0].message.content`. A non-2xx status surfaces
`error.message` from the provider body.

Five operations shape the prompt: `create`, `improve`, `seo`, `outline`, `chat`.
The first three instruct the model to return JSON with a documented key set;
`outline` and `chat` return Markdown.

## Site intelligence

`getSiteContext()` assembles, and sends to the model:

- `site`: title, description, URL
- `stats.totalPages`
- `plugins`: installed plugin directory names
- `pages`: up to **80** entries of `{key, title, type, description, content}` where
  `content` is `strip_tags()`-ed and truncated to **1800** characters

The `ai` operation additionally sends the selected page's raw content truncated
to **20,000** characters.

Two consequences worth stating plainly: the plugin sends site content to
whatever endpoint is configured, and the whole context block is rebuilt for
every request.

## Preview and approval workflow

The interactive path is genuinely review-first:

1. The user picks an operation, a page, and an instruction.
2. `handleAi()` returns the model's text; nothing is written.
3. `wizard.js` renders an editable form (title, slug, description, status,
   content).
4. Only **Apply this change** posts `action=save_page`, which calls
   `editPage()` or `createPage()`.
5. After the write, `buildPage()` re-reads the page and `pageSnapshot()` returns
   `{key, title, description, type, permalink}` as verification.

The Custom GPT API path has no such gate: `POST`/`PUT` write immediately, with
`confirm: true` on update and delete as the only acknowledgement.

## Native PHP independence

The plugin satisfies this by construction, and this server must not erode it:

- Works with any OpenAI-compatible endpoint; the base URL and model are free
  text with no allow-list.
- Requires no ChatGPT, no Cloudflare account, no OAuth registration with this
  service, and no developer-operated inference.
- The admin workflow is fully usable with no GPT Action key set at all.
- The only outbound dependency is the provider the user configures.

The hosted MCP server runs **no inference** and holds **no provider key**. Its
relationship to the plugin is optional and one-directional: when the plugin is
present, this server can use its pairing endpoint and report it as a capability.

## What this server needs from PHP, and what already exists

| Need | Status |
|---|---|
| Read site facts | Available: `GET /api/wizard/site`, and `GET /api/settings` on the official API |
| List / read pages | Available: `/api/wizard/pages`, `/api/wizard/pages/{key}` |
| Create / edit pages | Available: `POST`/`PUT /api/wizard/pages` |
| Tags, categories | **Only via the official Bludit API** (`/api/tags`, `/api/categories`). The Wizard API has no equivalent. |
| Search | Not available anywhere in Bludit. Implemented server-side. |
| Capability report | **Not available.** Proposed below. |
| Revision identity | **Not available.** Derived server-side from the page payload. |
| Pairing proof | **Not available.** Proposed below. |

## Proposed contracts

These are proposals, not implemented PHP. Nothing in this repository requires
them: the official Bludit API plus the ownership-file fallback is enough to
connect a site today, and the Wizard-specific paths improve the experience when
the plugin is installed.

### 1. `GET /api/wizard/pair` — site-side proof of control

Why: this server must not accept a pasted API token as proof that the caller
owns the site. A challenge the site can only answer if the caller configured the
GPT Action key is a usable proof.

Request:

```
GET /api/wizard/pair?challenge=<base64url, 43 chars>
Authorization: Bearer <wizardApiKey>
```

Response `200`:

```json
{
  "ok": true,
  "challenge": "<echoed unchanged>",
  "proof": "<base64url HMAC-SHA256>",
  "site": { "title": "…", "url": "…" },
  "pluginVersion": "1.0.5"
}
```

Where `proof = base64url(HMAC_SHA256(key = wizardApiKey, message = challenge))`.

Rules the server relies on:

- The challenge is echoed **exactly**, with no normalisation that could make two
  different values produce the same proof.
- `proof` is computed over the **raw challenge string**, before any URL decoding
  beyond what PHP already did.
- The endpoint must not be reachable without a valid Bearer key. The existing
  `503`-when-unconfigured behaviour is correct and should be preserved.

Errors: `400` for a missing challenge, `401` for a bad key, `500` if a valid key
is present but the HMAC cannot be computed.

Compatibility: purely additive. A plugin without this route simply 404s, and the
server falls back to the ownership file. The current `beforeAll()` dispatcher
already returns `{ok:false,error:"Unknown Wizard API endpoint."}` with `404` for
unmatched paths.

### 2. `GET /api/wizard/capabilities` — what this site supports

Why: this server currently infers support by probing endpoints one at a time,
which is slower and less precise than being told.

Response `200`:

```json
{
  "ok": true,
  "pluginVersion": "1.0.5",
  "bluditVersion": "3.22.0",
  "edition": "community",
  "operations": ["create", "improve", "seo", "outline", "chat"],
  "endpoints": { "pages": true, "site": true, "pair": true, "tags": false, "categories": false },
  "limits": { "pagesPerList": 200, "contentChars": 20000 },
  "deletionExposed": false
}
```

`edition` and `bluditVersion` are the fields this server cannot obtain any other
way, and they are the reason the compatibility matrix currently records
`detected: "unknown"`. If the plugin reports them, the MCP server can record a
**verified** edition instead of a declared one.

### 3. `GET /api/wizard/pages` pagination and revision

Two small additions that would remove server-side guesswork:

- `?page=1&perPage=50` with a `meta` block, replacing the fixed 200-row cap.
- A `revision` field per page (a hash of the stored page plus its `dateModified`),
  echoed by `PUT` and `DELETE`.

Until these exist, this server derives its own revision from the page payload
and caps its own scans. `PUT` has no way to say "only if unchanged", so
optimistic concurrency is enforced by the MCP server, not the CMS.

### 4. Delete exposure

`DELETE /api/wizard/pages/{key}` exists and is reachable with `confirm: true`.
Consistent with this project's policy, **no MCP tool exposes page deletion**, and
this server never calls that endpoint. If deletion is ever wanted through MCP it
should be a deliberate, separately reviewed decision, and the PHP API should then
return a recoverable artefact (a trash key) rather than an irreversible delete.

## Constraints this imposes on the hosted server

1. **Never require the plugin.** Every core tool works through the official
   Bludit API alone.
2. **Detect, do not assume.** `get_site_capabilities` reports what it found, so
   a missing plugin degrades one feature rather than breaking the site.
3. **Treat the Wizard API as a separate origin of truth.** It is a second HTTP
   surface with its own auth, its own error shape and its own limits, so it is
   implemented as a distinct path in the Bludit client rather than merged with
   the official API.
4. **Never send page content to a model.** This server performs no inference;
   content leaves the system only as tool results to the user's own MCP client.
5. **Budget for the plugin's own limits.** 200 pages per list, 1,800 characters
   of context per page. Server-side scans are bounded for the same reason.
