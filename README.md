# Bludit Wizard MCP

A local-first [Model Context Protocol](https://modelcontextprotocol.io) server for
[Bludit CMS](https://www.bludit.com). It gives MCP-compatible AI clients nineteen
tools for reading, searching, drafting and editing the pages of a Bludit site you
own — with a human review step before anything changes.

Run it on your own computer. There is no account, no hosted service, no OAuth
server, no database, and nobody else operating anything on your behalf. The server
speaks MCP over stdio and talks to one Bludit site through the official Bludit API
plugin.

- **Current release:** v1.0.0 (stable)
- **Tools:** 19, from one shared registry
- **Transport:** stdio (MCP)
- **Verified client:** OpenCode 2.0.21
- **Licence:** GPL-3.0-only, with the upstream MIT notice retained
- **Distribution:** GitHub release asset (this release is not published to the npm
  registry)

## Overview

Bludit Wizard MCP exposes a Bludit installation to an AI client without giving the
model unattended publishing rights. Reads and searches are direct. Writes either go
through an explicit proposal/approval workflow or through a direct tool call that
reports what actually landed, verified by reading the page back.

The server holds no model and performs no inference. It stores no page content. It
keeps no database: one process serves one site from configuration, and proposals
live in that process's memory.

It is derived from [`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) by
Diego Najar (MIT). The original six-tool stdio server is retained unchanged for
existing users; the nineteen-tool implementation in `src/local/` and `src/mcp/` is
the release target.

## Features

### Site management

| Tool | Purpose |
|---|---|
| `list_sites` | Show the configured site and its last capability report |
| `select_site` | Resolve a site id, label or hostname |
| `get_site_capabilities` | Probe the Bludit API and report what the site supports |

### Website information

| Tool | Purpose |
|---|---|
| `get_website_settings` | Read title, slogan, language, timezone, theme and URLs |

### Page retrieval

| Tool | Purpose |
|---|---|
| `list_pages` | List pages with type filters and pagination |
| `get_page` | Read one page, including raw Markdown and a revision identifier |
| `get_drafts` | List drafts |
| `get_scheduled_pages` | List pages scheduled for future publication |

### Taxonomy

| Tool | Purpose |
|---|---|
| `list_categories` | List categories |
| `list_tags` | List tags in use |

### Content intelligence

| Tool | Purpose |
|---|---|
| `search_pages` | Deterministic substring search on the server |
| `get_content_summary` | Deterministic stats, headings and warnings for a page |
| `get_related_pages` | Rank other pages by shared tags, category and title words |

### Controlled content modification

| Tool | Purpose |
|---|---|
| `create_page` | Create a page, then read it back |
| `edit_page` | Edit a page, then read it back; optional revision pin |
| `propose_page_edit` | Record an immutable, revision-pinned proposal without writing |
| `preview_page_changes` | Show the exact field and body diff a change would make |
| `apply_approved_edit` | Apply a proposal after re-checking its revision pin |
| `verify_page_update` | Check a page against expected revision, title, type and content |

There is **no deletion tool**. That is a policy decision, not an omission.

## Requirements

- **Node.js 20 or newer** (`node --version`).
- **Bludit 3.22.x** (Community or Pro) reachable over HTTPS.
- The Bludit **API plugin enabled**: *Admin → Plugins → API*.
- An **API token** from *Admin → Plugins → API → Settings*.
- For writes and settings, the admin user's **auth token** from
  *Admin → Users → your user → Security → Token*.

Without the auth token the server is read-only and says so on startup.

## Installation

This release is distributed as a package tarball attached to the GitHub release.
It is **not** published to the npm registry, so `npx bludit-wizard-mcp` is not
available from this release.

```bash
curl -LO https://github.com/gitdamnit/bludit-wizard-mcp/releases/download/v1.0.0/bludit-wizard-mcp-1.0.0.tgz
npm install -g ./bludit-wizard-mcp-1.0.0.tgz
bludit-wizard-mcp --version
```

`--version` prints to stderr and exits; the program is an MCP server and is not
meant to be used from a shell.

To install without touching the global prefix:

```bash
npm install --prefix "$HOME/.local/share/bludit-wizard-mcp" ./bludit-wizard-mcp-1.0.0.tgz
"$HOME/.local/share/bludit-wizard-mcp/node_modules/.bin/bludit-wizard-mcp" --version
```

From source:

```bash
git clone https://github.com/gitdamnit/bludit-wizard-mcp.git
cd bludit-wizard-mcp
npm ci
npm run build:local
node dist/local/index.js --version
```

## OpenCode Integration

Install the package as above, then add a local MCP server to
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "bludit": {
        "type": "local",
        "command": ["bludit-wizard-mcp"],
        "environment": {
          "BLUDIT_URL": "https://www.example.com",
          "BLUDIT_API_TOKEN": "{env:BLUDIT_API_TOKEN}",
          "BLUDIT_AUTH_TOKEN": "{env:BLUDIT_AUTH_TOKEN}"
        }
      }
    }
  }
}
```

Environment variables:

| Variable | Required | Meaning |
|---|---|---|
| `BLUDIT_URL` | yes | Site root, e.g. `https://www.example.com` (no `/api`) |
| `BLUDIT_API_TOKEN` | yes | API plugin token |
| `BLUDIT_AUTH_TOKEN` | no | User auth token; without it the site is read-only |
| `BLUDIT_WIZARD_API_KEY` | no | Optional Bludit Wizard plugin extension key |
| `BLUDIT_WIZARD_API_BASE` | no | Defaults to `<site>/api/wizard` |
| `BLUDIT_SITE_LABEL` | no | Display name, defaults to the hostname |
| `BLUDIT_ALLOW_INSECURE_URLS` | no | `true` allows plain HTTP on loopback only |
| `BLUDIT_CONFIG_FILE` | no | Path to a JSON config file |

Keep tokens in the environment rather than in the config file. If you do use a
config file, `chmod 600` it; the server warns when others can read it.

Restart OpenCode (or reload the session) after adding or changing the entry. The
tool list is read at server start.

## Other MCP Clients

The server is a standard stdio MCP server, so any client that can launch a local
process is expected to work. **Only OpenCode has been tested end to end.** The
following entry works for clients that use the common `mcpServers` shape, but it
is provided as a starting point, not as a claim of verified support:

```json
{
  "mcpServers": {
    "bludit": {
      "command": "bludit-wizard-mcp",
      "env": {
        "BLUDIT_URL": "https://www.example.com",
        "BLUDIT_API_TOKEN": "REPLACE_ME",
        "BLUDIT_AUTH_TOKEN": "REPLACE_ME"
      }
    }
  }
}
```

Remote-only clients need a stdio bridge or a future HTTP transport; the local
edition does not listen on a socket.

## Authentication

Two Bludit credentials serve different purposes:

- **API token** — required. It is the read credential. With only this token the
  server can list and read pages, categories, tags and capabilities, but cannot
  read site settings or write.
- **User auth token** — optional but required for writes and settings. It is sent
  only when the operation needs it.

Both travel in the request query string or JSON body according to the Bludit API
plugin's rules, exactly as Bludit expects. They are never printed, never logged,
and never returned in a tool response or error.

## Human-Controlled Editing

The recommended write path is:

1. **Propose** — `propose_page_edit` records an immutable proposal pinned to the
   page's current revision. Nothing is written.
2. **Preview** — `preview_page_changes` shows field-level changes and a unified
   Markdown diff, computed by the same code that applies the change.
3. **Approve** — a human decides. Approval is the act of calling the apply tool
   with `confirm: true`; there is no separate approval artifact locally.
4. **Apply** — `apply_approved_edit` claims the proposal, re-reads the page and
   refuses if the revision moved, applies the change, then reads it back.
5. **Verify** — `verify_page_update` checks the result against expectations.

Direct `create_page` and `edit_page` exist for callers that want immediate writes.
They also read the page back and report the revision before and after.

Revision pinning prevents the common case of applying a proposal built from a page
that has since changed, and it prevents replaying the same proposal. It cannot
prevent two writers racing at exactly the same moment: Bludit has no conditional
write, so when two independent writers both pass the revision check, the last
write wins. The same proposal cannot be applied twice.

## Security

- **SSRF policy** — site URLs must be HTTPS (loopback HTTP only with the explicit
  development flag). Loopback, private, link-local and cloud-metadata addresses are
  rejected, as are embedded credentials, invalid ports and unsupported schemes.
  Redirects are re-validated at every hop; a redirect to a restricted address is
  refused.
- **Bounded responses** — response bodies are capped, requests time out, and a
  truncated or oversized body is an error rather than partial data.
- **Structured failures** — errors use stable codes such as `invalid_input`,
  `not_found`, `site_auth_failed`, `revision_mismatch`, `conflict`,
  `proposal_expired`, `site_unreachable` and `upstream_error`. Upstream bodies and
  credentials are not echoed.
- **No inference, no storage** — the server calls no model and keeps no page
  content. Proposals and capability results live in process memory.
- **No deletion, no unattended publication** — those tools do not exist.
- **Malformed upstream responses** — a `200` response that is not valid JSON is
  reported as `upstream_error`, never as an empty success.

## Troubleshooting

**`BLUDIT_URL is required` / `BLUDIT_API_TOKEN is required`** — the process exits
at startup by design. Set both variables.

**`site_auth_failed` on reads** — check the API plugin is enabled and the API token
matches *Admin → Plugins → API → Settings*.

**`site_auth_failed` on writes or settings** — add `BLUDIT_AUTH_TOKEN` from
*Admin → Users → your user → Security → Token*. The startup banner prints
`[read-only]` when it is missing.

**`site_unreachable`** — the site is down, the URL is wrong, TLS failed, or the
request timed out. Check the base URL is the site root, not an `/api` path.

**`not_found` from a page read** — Bludit page keys are slugs, possibly
hierarchical (`parent/child`). An HTTP 404 can also mean the API plugin is
disabled.

**New page not visible immediately** — a newly created key has occasionally taken
a moment to become readable through a separate request on shared hosting. The
server's own read-back succeeded and a retry resolves it.

**OpenCode does not show the tools** — confirm the `command` path exists, check
stderr in the OpenCode logs, then reload the session or restart OpenCode.

## Known Limitations

- No page deletion and no unattended publication.
- Proposals are held in process memory, expire after 15 minutes by default, and do
  not survive a restart. Re-propose after a restart.
- Revision pinning does not serialise two independent writers racing on the same
  revision; last write wins in that edge case.
- Bludit derives slugs from titles and keeps punctuation and Unicode, so generated
  page keys can contain them.
- Bludit escapes HTML-like text and special characters on store; read-back is the
  stored form, not necessarily a byte-for-byte copy of the input.
- `search_pages` with `include_content: true` requires an explicit
  `scan_limit <= 40`, because every scanned page is a separate upstream request.
- Site settings require the user auth token.
- Only OpenCode has been verified as an MCP client.
- The Cloudflare Workers transport is preserved in the source but is not part of
  the local distribution.

## Testing

Final verification for v1.0.0:

- **438 hermetic tests** across 27 files — MCP protocol, all 19 tools, validation,
  authentication, SSRF, revisions, proposals, failure recovery, packaging helpers.
- **9 Playwright browser tests** for the authorization-server pages.
- **18 Docker-backed live tests** against a disposable Bludit Community 3.22.0
  installation (12 hosted-transport compatibility tests, 6 local stdio tests),
  0 failed.
- **Live acceptance** against a disposable Bludit site through OpenCode: all 19
  tools exercised, ~90 isolated positive/negative probes, read-only and write
  workflows, restart and concurrency behaviour.

The acceptance report and its machine-readable evidence are in
[`docs/LIVE_ACCEPTANCE_REPORT.md`](docs/LIVE_ACCEPTANCE_REPORT.md) and
`docs/evidence/live-acceptance-2026-10-17.json`.

## Licence

**GPL-3.0-only.** See [LICENSE](LICENSE) for the complete GNU General Public
License version 3 text and [NOTICE](NOTICE) for the retained upstream MIT licence,
copyright notices and dependency licences. The complete corresponding source for
the v1.0.0 release is <https://github.com/gitdamnit/bludit-wizard-mcp/tree/v1.0.0>.

This project is a derivative of
[`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) by Diego Najar, pinned
at commit `73b5ddcb92015d1359370ba2613090eef6af910c`. The original MIT copyright
notice is retained in full, the repository keeps upstream's complete Git history,
and `src/index.js` is upstream code with only a provenance header added.

Bludit itself is a separate project. This server talks to a Bludit site over its
HTTP API; it does not bundle or modify Bludit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Two rules matter most: do not claim a
client or Bludit edition works until it has been tested, and do not merge upstream
silently. Run `npm run typecheck`, `npm test` and `npm run test:browser` before
opening a pull request, and keep the nineteen-tool surface and its error contracts
intact unless a release-blocking defect justifies a documented change.
