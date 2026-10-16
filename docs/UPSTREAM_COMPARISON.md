# Upstream comparison

This document accounts for exactly what came from
[`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) and what was written
for Bludit Wizard MCP. Nothing upstream is presented as independently authored.

## Pinned upstream

| | |
|---|---|
| Repository | `https://github.com/bludit/bludit-mcp` |
| Pinned commit | `73b5ddcb92015d1359370ba2613090eef6af910c` |
| Branch | `main` |
| Commit date | 2026-09-09 |
| Commit count at pin | 16 |
| Licence | MIT |
| Copyright | © 2026 Diego Najar |
| Package | `bludit-mcp@0.1.0` |
| Source | one file, `src/index.js` (200 lines) |

The clone retains the full upstream history. Running `git log` on this repository
still shows all 16 upstream commits, including the two Dependabot merges, so
attribution survives at commit granularity rather than only in prose.

**Do not silently merge upstream.** The upstream project is tracked as the
`upstream` remote and is never pulled automatically. Any future upstream change
is a reviewed, deliberate act, recorded in this file and as its own commit. See
"Tracking upstream" below.

## Upstream functionality, as it stands at the pin

`src/index.js` is a **stdio** MCP server for one Bludit site, configured from
three environment variables.

| Aspect | Upstream behaviour |
|---|---|
| Transport | stdio only (`StdioServerTransport`) |
| Identity | none — whoever can start the process has full access |
| Sites | exactly one, from `BLUDIT_URL` / `BLUDIT_API_TOKEN` / `BLUDIT_AUTH_TOKEN` |
| Tools | 5: `get_website_settings`, `list_pages`, `get_page`, `create_page`, `edit_page`, `delete_page` (6 including delete) |
| Startup | fetches website settings once and bakes the site name and language into the server instructions |
| Errors | `throw new Error("Bludit API <status>: <message>")` |
| Tests | none |
| CI | publishes to npm when a GitHub release is published |

The transport rules it encodes are correct and were reused rather than
rediscovered: the API plugin reads `$_GET` for GET/DELETE and the raw body for
POST/PUT, so the read-only `token` goes in the query string for reads and in the
JSON body for writes, with `authentication` added for writes.

## File-by-file provenance

| Path | Provenance |
|---|---|
| `src/index.js` | **Upstream, unchanged** except an added provenance header comment. Retained so existing stdio users keep working. |
| `LICENSE` | **Upstream notice preserved**, with the derivative's copyright line added. |
| `NOTICE` | New. Records the upstream project, the pin, and what is inherited versus new. |
| `package.json` | Upstream file, rewritten: renamed to `bludit-wizard-mcp`, dependencies replaced, scripts replaced. |
| `package-lock.json` | Regenerated for the new dependency set. |
| `.gitignore` | Upstream file, extended (`.wrangler/`, `reports/`, `.dev.vars`). |
| `.github/workflows/publish.yml` | **Removed.** It published to npm on release, which is not a workflow this project wants. Replaced by `.github/workflows/ci.yml`. |
| `migrations/`, `src/shared/`, `src/bludit/`, `src/sites/`, `src/proposals/`, `src/audit/`, `src/auth/`, `src/mcp/`, `test/`, `docs/`, `wrangler.*` | **New.** |
| `README.md` | Rewritten. The upstream README documents a single-site stdio setup; that content is preserved in [stdio-server usage](#stdio-server-usage-legacy) below. |

## Behavioural differences, and why

### 1. Hosted, multi-tenant, and authenticated

Upstream is a per-user local process; having the binary is the whole
authorization model. A hosted service cannot work that way, so identity, client
identity, site ownership and tool authorization are four separate things:

- an **account** on this service (D1 `users`);
- an **OAuth client** (the app the user connects, tracked by the OAuth provider);
- a **connected site** (owned by one account);
- a **grant**, which ties one client to one account and carries its scopes.

The MCP resource server reads identity only from the validated access token,
never from tool arguments, so a tool argument can at most select which of the
caller's own sites to act on.

### 2. Streamable HTTP with OAuth 2.1

Upstream has no HTTP surface. The hosted server implements RFC 9728 protected
resource metadata, RFC 8414 authorization server metadata, Authorization Code
with PKCE, Refresh Tokens, Dynamic Client Registration and Client ID Metadata
Documents, token revocation, and scope step-up. See `ARCHITECTURE.md`.

### 3. Site credential handling

Upstream reads credentials from the environment. The hosted server stores them
in D1 encrypted with AES-256-GCM, keyed by a Worker secret, with the site id as
additional authenticated data. They are decrypted for one outbound call and
never logged or returned.

### 4. Tool catalogue

Upstream exposes 6 tools, including `delete_page`.

| | Upstream | Bludit Wizard MCP |
|---|---|---|
| Tools | 6 | 19 |
| Deletion | `delete_page` exposed | **not exposed by any tool** |
| Listing payload | full page objects including rendered HTML | summaries; `get_page` returns the body |
| Concurrency | none | revision identifiers, optional `expected_revision` on edit |
| Review workflow | none | propose → preview → apply → verify, with a revision pin |
| Capability reporting | none | `get_site_capabilities` |
| Site selection | implicit (one site) | `list_sites` / `select_site` / explicit `site` argument |
| Startup context | site settings fetched once at boot | static instructions; site context fetched per call |

The deletion decision is a policy choice, argued in `SECURITY.md`. Bludit has no
soft-delete, so an exposed delete is unrecoverable through the API, and no
client has demonstrated a need for it.

The listing change addresses a real cost: returning every page with its rendered
body fills a model's context with HTML it did not ask for.

### 5. Error handling

Upstream throws a string message. The hosted server returns a structured,
non-retryable-marked error with a stable code (`not_found`,
`revision_mismatch`, `capability_unavailable`, …) and never includes a
credential or an upstream body. Codes are listed in `MCP_TOOLS.md`.

### 6. Startup behaviour

Upstream fetches website settings at import time and embeds them in the server
instructions. That is correct for one site and one user, and wrong for a hosted
server serving many accounts: it would freeze one tenant's settings into every
request. Instructions are now static and site data is fetched per call.

### 7. Dependencies

| Upstream | Here | Note |
|---|---|---|
| `@modelcontextprotocol/sdk` ^1.0.0 | 1.32.1 | pinned; `registerTool` API |
| `zod` ^3.23.0 | 4.6.7 | pinned |
| — | `@cloudflare/workers-oauth-provider` 1.2.3 | the officially supported OAuth 2.1 provider |
| — | `hono` 4.13.13 | server-rendered pages and routing |
| — | `@cfworker/json-schema` 4.1.1 | the SDK's Workers-compatible schema validator |

All versions are exact rather than ranged, so a build is reproducible. The npm
bug that forces `legacy-peer-deps` is documented in `DEPLOYMENT.md`.

## What was kept from upstream on purpose

- The **transport rules** for the Bludit API plugin, including the comment's
  substance, because getting them wrong produces confusing 401s.
- The **stdio server**, unchanged, so the people already using it are not broken
  by this repository existing.
- The **MIT licence and copyright notice**, in full.

## stdio server usage (legacy)

Still works exactly as documented upstream:

```json
{
  "mcpServers": {
    "bludit": {
      "command": "npx",
      "args": ["-y", "bludit-mcp"],
      "env": {
        "BLUDIT_URL": "https://www.example.com",
        "BLUDIT_API_TOKEN": "...",
        "BLUDIT_AUTH_TOKEN": "..."
      }
    }
  }
}
```

Or from this repository: `npm run start:stdio`.

It reads one site from the environment, serves one user, and offers six tools
including deletion. It has no OAuth, no multi-site support, no proposal
workflow and no capability reporting. Use the hosted server for anything beyond
a single trusted site on your own machine.

## Tracking upstream

The `upstream` remote is configured read-only in practice:

```
git remote -v
# upstream  https://github.com/bludit/bludit-mcp.git (fetch)
```

To evaluate a future upstream change:

1. `git fetch upstream`
2. Review `git log --oneline HEAD..upstream/main` and `git diff HEAD...upstream/main`
3. Decide per commit. Expect most upstream changes to touch only
   `src/index.js` (the stdio server) and be adoptable verbatim.
4. Record the decision and the new pin in this document in the same commit.

Never merge upstream wholesale: the two projects now have different transports,
different identities and different safety models, and a silent merge would
reintroduce `delete_page` and the startup-settings fetch.
