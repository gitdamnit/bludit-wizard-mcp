# Client setup guides

One section per target client, with the exact configuration and the caveats. Every
template referenced here is in [`templates/`](clients/templates/) and can be copied
verbatim.

**No guide below contains a secret.** OAuth clients need only a URL. The four
header-only clients need a personal access token, which you create in the account
UI and paste into a client-side secret store or environment variable — never into
this repository.

## Before you start

You need a deployed server and, for anything other than the OAuth clients, a
token.

| | |
|---|---|
| MCP endpoint | `https://mcp.evanzellner.com/mcp` |
| Authorize a client | Sign in, connect a Bludit site, then approve the client when it asks |
| Create a token | Sign in → **Personal access tokens** → **Create token** |
| Revoke a token or client | The same two pages |

The endpoint is a placeholder until the first deployment. Everything else in these
guides is real.

### Which credential does my client need?

| Client needs | Use | Why |
|---|---|---|
| OAuth with discovery | Just the URL | Preferred: no long-lived secret on disk, revocable per client |
| A fixed `Authorization` header | A personal access token | GitHub Copilot cloud agent/code review, Mistral Vibe Code CLI, Empryo |

A personal access token and an OAuth token are checked by the same authorization
code, carry the same scopes, and obey the same tenancy and safety rules. The only
difference is how the token was obtained, and that a token is long-lived until you
revoke or expire it.

---

## OAuth clients

### 1. OpenAI Codex

**Supports:** Streamable HTTP; OAuth with CIMD *and* DCR; bearer env var; static
headers. CIMD is chosen automatically when the authorization server advertises it,
which this one does in production.

**Configure:** edit `~/.codex/config.toml`.

```toml
[mcp_servers.bludit-wizard]
url = "https://mcp.evanzellner.com/mcp"
```

Template: `templates/codex-config.toml`

**Note.** Codex CLI, the IDE extension and the desktop app share this MCP
configuration. Codex Cloud is a separate surface whose documentation does not
mention MCP at all, so it is untested and unclaimed.

### 2. Cursor

**Supports:** Streamable HTTP and legacy SSE; OAuth with DCR by default, or a
pre-registered client.

**Configure:** `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally.

```json
{ "mcpServers": { "bludit-wizard": { "url": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/cursor-mcp.json`

**Note.** Cursor's documented redirect URIs are
`https://www.cursor.com/agents/mcp/oauth/callback` and
`http://localhost:8787/callback`. Both are accepted by this server's registration
policy (https anywhere, plain http only on loopback).

### 3. JetBrains AI Assistant

**Supports:** Streamable HTTP, legacy SSE, stdio.

**Authentication: not documented.** The AI Assistant MCP documentation shows a
`url` and nothing else — no headers, no OAuth. Whether it performs OAuth discovery
is unknown.

**Configure:** Settings | Tools | AI Assistant | Model Context Protocol (MCP).

```json
{ "mcpServers": { "bludit-wizard": { "url": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/jetbrains-ai-assistant-mcp.json`

**Expected outcome.** This server always requires a credential, so unless AI
Assistant performs OAuth discovery it will receive a `401`. **Untested, and
unverifiable without the IDE.** If it fails, the honest conclusion is that this
client cannot authenticate to a credential-requiring remote MCP server today.

### 4. JetBrains Junie

Two surfaces with different answers.

**Junie CLI — supported.**

```json
{ "mcpServers": { "bludit-wizard": { "url": "https://mcp.evanzellner.com/mcp" } } }
```

Paths: `~/.junie/mcp/mcp.json` (user) or `<project>/.junie/mcp/mcp.json`.
The CLI documents OAuth and static headers. Template: `templates/junie-cli-mcp.json`

**Junie IDE plugin — not supported.** Its documentation states: "At the moment,
Junie does not support security tokens in MCP configs." With no credential
mechanism, there is no way to reach an authenticated server, over any transport.
Template: `templates/junie-ide-plugin.mcp.json` (documents the gap).

### 5. JetBrains Air

**Supports:** remote HTTP and stdio; bearer headers; OAuth with a Connect button.

```json
{ "mcpServers": { "bludit-wizard": { "url": "https://mcp.evanzellner.com/mcp" } } }
```

Paths: `.air/mcp.json` (local) or `.mcp.json` (workspace), plus a global scope.
Template: `templates/jetbrains-air-mcp.json`

### 6. VS Code / GitHub Copilot agent mode

**Supports:** Streamable HTTP with an SSE fallback; OAuth using DCR, falling back
to a client-credentials workflow.

**Configure:** `.vscode/mcp.json` (note the top-level key is `servers`), or
`.mcp.json` at the workspace root (top-level key `mcpServers`, and **SSE is not
supported in that file**).

```json
{ "servers": { "bludit-wizard": { "type": "http", "url": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/vscode-mcp.json`

**Note.** VS Code's documented required redirect URLs are
`http://127.0.0.1:33418` and `https://vscode.dev/redirect`. Both are accepted.

### 7. GitHub Copilot CLI

**Supports:** Streamable HTTP, legacy SSE, stdio; static headers.

```json
{
  "mcpServers": {
    "bludit-wizard": {
      "type": "http",
      "url": "https://mcp.evanzellner.com/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_PERSONAL_ACCESS_TOKEN" }
    }
  }
}
```

Path: `~/.copilot/mcp-config.json`. Template: `templates/copilot-cli-mcp.json`

OAuth support is undocumented for this surface, so a token is the safe choice. If
you prefer OAuth, try the URL with no headers first.

### 8. Google Antigravity

**Supports:** Streamable HTTP, legacy SSE, stdio; OAuth with automatic DCR,
pre-registered client, Google Application Default Credentials, and static headers.

**Configure:** its documented `mcpServers` shape. The file path is not stated in
Antigravity's documentation; the SDK auto-discovers `.agents/mcp_config.json`.

```json
{ "mcpServers": { "bludit-wizard": { "serverUrl": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/antigravity-mcp.json`

**Note.** Antigravity's documented OAuth callback is
`https://antigravity.google/oauth-callback`, which this server's registration
policy accepts.

### 9. Cline

**Supports:** Streamable HTTP and legacy SSE (`type` must be set explicitly;
omitting it defaults to legacy SSE), stdio, OAuth through a browser authorize
step, and static headers.

```json
{
  "mcpServers": {
    "bludit-wizard": {
      "type": "streamableHttp",
      "url": "https://mcp.evanzellner.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Path: `~/.cline/data/settings/cline_mcp_settings.json`. Template:
`templates/cline-mcp-settings.json`

Cline's docs do not state which client-registration mechanism it uses. DCR is
enabled here, and a pre-registered client is possible if needed.

### 10. Kilo Code

**Supports:** Streamable HTTP first with an automatic SSE fallback; OAuth 2.0; static
headers.

```json
{
  "mcp": {
    "bludit-wizard": {
      "type": "remote",
      "url": "https://mcp.evanzellner.com/mcp",
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

Paths: `~/.config/kilo/kilo.jsonc` or `<project>/kilo.jsonc`. Template:
`templates/kilo.jsonc`

### 11. Claude

Anthropic documents one shared connector infrastructure for claude.ai, Claude
Desktop, mobile, Claude Code and Cowork, and says the requirements apply to all of
them. This is the strictest documented client, and it is the one that drove two
fixes on this server.

**Claude Code** — project `.mcp.json`, or user scope in `~/.claude.json`:

```json
{ "mcpServers": { "bludit-wizard": { "type": "http", "url": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/claude-code-mcp.json`

> A JSON entry with a `url` but no `type` is read as a **stdio** server. Always set
> `"type": "http"`.

**Claude Desktop and Claude web / Cowork** — no config file. Sign in to Claude,
then **Customize → Connectors → Add custom connector → Web**, and enter the MCP
server URL. Anthropic's cloud infrastructure connects to your server, so the
endpoint must be publicly reachable — including from Anthropic's egress range
`160.79.104.0/21`.

**What Claude requires, and how this server meets it:**

| Requirement | Status |
|---|---|
| `401` with `resource_metadata` to start sign-in | Met |
| `WWW-Authenticate` on a `200` is ignored — a `401` is mandatory | Met: the server always answers `401` when unauthenticated |
| Only the first `authorization_servers` entry is used | Met: exactly one is advertised |
| PKCE `S256` | Met, and required |
| CIMD selected only when metadata advertises support **and** `none` | Met |
| `readOnlyHint` **and** `destructiveHint` on **every** tool | Met: all 19 declare all four hints |
| Refresh tokens rotate for public clients | Met |
| No resource subscriptions, sampling or draft capabilities | None used |
| Public HTTPS reachability from Anthropic's cloud | Requires deployment |

### 12. OpenCode

Two configuration shapes; check which you are on.

**V2** — `mcp.servers` in `opencode.jsonc` (`~/.config/opencode/opencode.jsonc` or
a project file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "bludit-wizard": { "type": "remote", "url": "https://mcp.evanzellner.com/mcp" }
    }
  }
}
```

Template: `templates/opencode-v2.jsonc`

**V1** — servers directly under `mcp`, with `enabled`:

```json
{ "mcp": { "bludit-wizard": { "type": "remote", "url": "https://mcp.evanzellner.com/mcp", "enabled": true } } }
```

Template: `templates/opencode-v1.json`

**Note.** OpenCode V2 supports CIMD, DCR and a pre-registered client, and its
`protocol` setting defaults to `legacy` — it speaks revisions up to 2025-11-25.
This server negotiates older revisions, verified in
`test/integration/protocol-surface.test.ts`.

### 13. Empryo — needs a token

**Supports:** `http` (Streamable HTTP), `sse`, stdio; **static headers only**.
OAuth is not documented.

```json
{
  "mcpServers": [
    {
      "name": "bludit-wizard",
      "transport": "http",
      "url": "https://mcp.evanzellner.com/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_PERSONAL_ACCESS_TOKEN" }
    }
  ]
}
```

Paths: `~/.empryo/config.json` or `<project>/.empryo/config.json`. Template:
`templates/empryo-config.json`

Empryo also documents `redirect: "follow" | "error"`; this server performs no
redirects on the MCP endpoint, so either is fine.

### 14. Mistral

Three relevant surfaces, with different answers.

**Le Chat — supported.** UI only: Connectors → **+ Add Connector** → **Custom MCP
Connector** → name + `https://mcp.evanzellner.com/mcp` → Connect. Mistral
auto-detects the auth method and documents OAuth 2.1 **with DCR**, which this
server supports.

**AI Studio Connectors — supported, pre-registered client.** Register in Studio
with the URL, visibility, and OAuth `client_id` plus `client_secret`, or a static
header for an API-key server. Studio does not document DCR, so the pre-registered
path is the one to use. Note the feature is marked Public Preview.

**Vibe Code CLI — needs a token.** Its documentation states: "the CLI does not yet
support MCP servers that require OAuth authentication." Append to
`~/.vibe/config.toml`:

```toml
[[mcp_servers]]
name = "bludit_wizard"
transport = "streamable-http"
url = "https://mcp.evanzellner.com/mcp"
api_key_env = "BLUDIT_WIZARD_TOKEN"
api_key_header = "Authorization"
api_key_format = "Bearer {token}"
```

Template: `templates/mistral-vibe-config.toml`

**"Mistral Code"** has no official MCP documentation under that name; Mistral's
documented coding CLI is Vibe Code.

### 15. Gemini

Four surfaces.

**Gemini CLI — supported.** `mcpServers` in `~/.gemini/settings.json` or
`<project>/.gemini/settings.json`:

```json
{ "mcpServers": { "bludit-wizard": { "httpUrl": "https://mcp.evanzellner.com/mcp" } } }
```

Template: `templates/gemini-settings.json`

> Use `httpUrl` for Streamable HTTP. `url` selects the legacy SSE transport.

Gemini CLI requires the `iss` parameter in the OAuth callback when the
authorization server advertises `authorization_response_iss_parameter_supported`,
which this one does — and it is sent, verified in `oauth-security.test.ts`.

Note: Gemini CLI was reported replaced by Antigravity CLI for unpaid tiers on
2026-06-18. The documentation remains current, and the client is still listed here
because the requirement names it.

**Gemini API managed agents — supported with a token.** MCP servers are a `tools[]`
entry, not a config file. See `templates/gemini-api-tools.json`. The server name
must match `^[a-z0-9_-]+$`.

**Gemini apps (consumer) — supported.** Settings → **Connected Apps** →
**Custom apps**, entering the MCP server URL. Mistral-style auto-detection does not
apply: Gemini asks for credentials only if DCR is unsupported, and DCR is
supported here. Availability is currently limited (18+, US, personal account,
Activity on, English).

**Gemini Enterprise — supported, pre-registered client, Streamable HTTP only.**
Enterprise explicitly does **not** support SSE, which this server does not use, and
requires a publicly trusted TLS certificate — so `workers.dev` certificates are
fine but a self-signed one is not.

---

## Summary

| Approach | Clients |
|---|---|
| Point at the URL, approve in a browser | Codex, Cursor, Junie CLI, JetBrains Air, VS Code, Antigravity, Cline, Kilo Code, Claude Code, Claude Desktop/web, OpenCode, Mistral Le Chat, Gemini CLI, Gemini apps |
| Pre-registered OAuth client | Mistral AI Studio, Gemini Enterprise |
| Personal access token | GitHub Copilot cloud agent and code review, Copilot CLI (if OAuth unavailable), Mistral Vibe Code CLI, Empryo, Gemini API managed agents |
| Unverified | JetBrains AI Assistant (remote auth undocumented), Codex Cloud (MCP not documented) |
| Not supported | JetBrains Junie IDE plugin (no token support) |

## If a client does not work

1. `curl -s -o /dev/null -D - https://mcp.evanzellner.com/mcp` and confirm the
   `401` carries `WWW-Authenticate` with `resource_metadata`.
2. Fetch `/.well-known/oauth-protected-resource` and confirm the issuer matches the
   one the client discovered.
3. Check the audit page and the Connected clients page to see whether the client
   registered and whether a grant exists.
4. If the client cannot do OAuth, create a personal access token and configure the
   header instead.
5. Record the outcome. Today every row of
   [CLIENT_COMPATIBILITY_MATRIX.md](CLIENT_COMPATIBILITY_MATRIX.md) says "not
   tested"; your result is what changes that.
