# Client compatibility matrix

**No client product has been tested against this server.** That is stated once
here and repeated in every row, because a matrix like this is exactly where a
compatibility claim gets made by accident.

What the rows *do* record:

- **Transport** and **Auth** — what the client's official documentation says it
  supports, with the source cited.
- **Configuration** — the real config shape from that documentation.
- **Read / Proposed edit / Approved write / Verified result** — that **this
  server** supports the operation, proven by
  `test/integration/client-journey.test.ts`, which walks all nine steps for both
  an OAuth token and a personal access token. These columns describe the server,
  not the client.
- **Tested version** — `not tested`, for every client. Nothing else is honest.

Research date: 2026-10-16. Sources are linked per client below.

## Master matrix

**Local stdio:** OpenCode 2.0.21 is verified end to end against the local stdio
edition (19/19 tools). The matrix below tracks the hosted HTTP transports, where
no client has been verified. See [`LIVE_ACCEPTANCE_REPORT.md`](./LIVE_ACCEPTANCE_REPORT.md).

Legend — Transport: `HTTP` Streamable HTTP · `SSE` legacy SSE · `stdio` local
process. Auth: `OAuth` with discovery · `DCR` Dynamic Client Registration · `CIMD`
Client ID Metadata Document · `HDR` static headers · `PAT` this server's personal
access token · `—` none documented. Verified result: `✅ server` = the server
performs and verifies the operation (journey test); `❌ client` = not tested.

| Client surface | Transport | Auth | Configuration | Tested version | Read | Proposed edit | Approved write | Verified result |
|---|---|---|---|---|---|---|---|---|
| **OpenAI Codex** (CLI, IDE ext., desktop — shared config) | HTTP, stdio | OAuth, CIMD, DCR, HDR | `~/.codex/config.toml` → `[mcp_servers.<id>]` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **OpenAI Codex Cloud** | Unknown | Unknown | MCP not documented | ❌ not tested | — | — | — | ❌ **unknown** |
| **Cursor** | HTTP, SSE, stdio | OAuth, DCR, HDR, pre-registered | `.cursor/mcp.json` or `~/.cursor/mcp.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **JetBrains AI Assistant** | HTTP, SSE, stdio | **Unknown — undocumented** | Settings → Tools → AI Assistant → MCP | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ **auth unknown** |
| **JetBrains Junie — IDE plugin** | stdio shown only | **None — documented as unsupported** | `~/.junie/mcp/mcp.json` | ❌ not tested | — | — | — | ❌ **unsupported** |
| **JetBrains Junie — CLI** | HTTP, stdio | OAuth, HDR | `.junie/mcp/mcp.json`, `~/.junie/mcp/mcp.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **JetBrains Air** | HTTP, stdio | OAuth, HDR | `.air/mcp.json`, `.mcp.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **VS Code** (Copilot agent mode) | HTTP (SSE fallback), stdio | OAuth, DCR, HDR | `.vscode/mcp.json`, `.mcp.json`, `$COPILOT_HOME/mcp-config.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **GitHub Copilot cloud agent** | HTTP, SSE | **HDR only — OAuth not supported** | GitHub repo → Settings → Copilot → MCP servers | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client (needs PAT) |
| **GitHub Copilot code review** | HTTP, SSE | **HDR only — OAuth not supported** | same as above | ❌ not tested | ✅ server | ✅ server | ⚠️ see note | ❌ client (needs PAT) |
| **GitHub Copilot CLI** | HTTP, SSE, stdio | HDR | `~/.copilot/mcp-config.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Google Antigravity** | HTTP, SSE, stdio | OAuth, DCR, HDR, ADC | `mcpServers` object (path not documented) | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Cline** | HTTP, SSE, stdio | OAuth, HDR | `~/.cline/data/settings/cline_mcp_settings.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Kilo Code** | HTTP, SSE fallback, stdio | OAuth, HDR | `mcp` key in `kilo.jsonc` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Claude Code** | HTTP, SSE, stdio, WebSocket | OAuth, CIMD, DCR, HDR | `~/.claude.json` or project `.mcp.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Claude Desktop** | HTTP (via connectors), stdio | OAuth, CIMD, DCR | Customize → Connectors (remote); `claude_desktop_config.json` (stdio) | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Claude web / Cowork connectors** | HTTP, SSE legacy | OAuth, CIMD, DCR | UI only | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **OpenCode** (V2) | HTTP, stdio | OAuth, CIMD, DCR, pre-registered, HDR | `mcp.servers` in `opencode.jsonc` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **OpenCode** (V1) | HTTP, stdio | OAuth, DCR, HDR | `mcp` in `opencode.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Empryo** | HTTP, SSE, stdio | **HDR only — OAuth not documented** | `mcpServers` in `~/.empryo/config.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client (needs PAT) |
| **Mistral Le Chat** | HTTP (remote URL) | OAuth, DCR, HDR | UI → Connectors → Custom MCP Connector | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Mistral AI Studio Connectors** | HTTP (remote URL) | Pre-registered OAuth, HDR | Studio UI / beta Connectors API | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Mistral Vibe Code CLI** | HTTP, streamable-http, stdio | **HDR/API key only — OAuth not supported** | `[[mcp_servers]]` in `~/.vibe/config.toml` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client (needs PAT) |
| **Mistral Code** | — | — | No official MCP documentation | ❌ not tested | — | — | — | ❌ **not applicable** |
| **Gemini CLI** | HTTP (`httpUrl`), SSE (`url`), stdio | OAuth, DCR, HDR, ADC | `mcpServers` in `~/.gemini/settings.json` | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Gemini API managed agents** | HTTP | HDR (+ `credential`) | `tools[]` entry in the interaction | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Gemini apps (consumer)** | HTTP (transport not stated) | DCR, manual credentials | Settings → Connected Apps (UI) | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |
| **Gemini Enterprise** | **HTTP only — SSE not supported** | Pre-registered client, PKCE | Enterprise data-store setup | ❌ not tested | ✅ server | ✅ server | ✅ server | ❌ client |

### Notes on two rows

**GitHub Copilot code review, approved write.** Copilot code review is documented
to require `annotations.readOnlyHint === true` on any tool it uses, which means it
will never call a write tool. The server supports writes with a token that holds
`pages:write`; whether Copilot code review would ever invoke one is a property of
Copilot, not of this server. The honest answer is "the server supports it; the
client is documented not to."

**Claude web / Cowork.** Same client as Claude Desktop for MCP purposes — Anthropic
documents one shared connector infrastructure for claude.ai, Desktop, mobile,
Claude Code and Cowork, and states the requirements "apply to all of them".

## Client-side requirements this server is known to satisfy

These are the only documented, testable client requirements found in the research.
Each is asserted against the running server.

| Requirement | Documented by | Status | Evidence |
|---|---|---|---|
| `401` with `resource_metadata` to start sign-in; a `WWW-Authenticate` on `200` is ignored | Claude | ✅ | `protocol-surface.test.ts` |
| Exactly one entry in `authorization_servers` | Claude | ✅ | `production-shape.test.ts` |
| PKCE `S256` | Claude, Codex, OpenCode, VS Code | ✅ | `oauth-security.test.ts` |
| CIMD advertised as `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported` | Claude, Codex, OpenCode | ✅ | `production-shape.test.ts` |
| **Both** `readOnlyHint` and `destructiveHint` on every tool | Claude | ✅ (fixed) | `protocol-surface.test.ts`, all 19 tools |
| `readOnlyHint: true` on tools a read-only agent may call | GitHub Copilot code review | ✅ | same |
| Refresh tokens rotate for public clients | Claude | ✅ | library-provided; `oauth-security.test.ts` |
| RFC 9207 `iss` in the authorization response | Gemini CLI | ✅ | `oauth-security.test.ts` |
| Streamable HTTP only, no SSE endpoint required | Gemini Enterprise | ✅ | `protocol-surface.test.ts` |
| `Accept` header tolerance | — (defensive) | ✅ (added) | `protocol-surface.test.ts`, four variants |
| No `Mcp-Session-Id` required, no held-open GET required, no `outputSchema` required | no client documents these | ✅ not needed | `protocol-surface.test.ts` |

## Known limitations, stated plainly

1. **No client has been tested.** Every "verified result" cell in the master
   matrix is `❌ client`. The nine-step journey proves the *server*; it proves
   nothing about any product.
2. **A client that understands only SSE is not served.** Responses are a single
   JSON body (`enableJsonResponse`). No target client documents requiring an SSE
   response body.
3. **No `outputSchema`** on any tool. No client documents requiring one.
4. **A client that requires `Mcp-Session-Id`** would not work; the server is
   stateless. No client documents requiring one.
5. **JetBrains AI Assistant remote authentication is undocumented.** It may work
   unauthenticated-only; this server always requires a credential, so a `url`-only
   configuration returns `401`.
6. **The Junie IDE plugin cannot be served** — it documents no token support.
7. **A personal access token is a long-lived bearer credential** in a client config
   file. See `SECURITY.md` and ADR-020.
8. **Everything is HTTP over TLS in production.** The live and integration
   evidence in this repository is loopback. A remote client needs a public HTTPS
   deployment, which does not exist yet.

## Sources

| Client | Official documentation |
|---|---|
| OpenAI Codex | `developers.openai.com/codex/mcp/`, `developers.openai.com/codex/config-file/config-reference` |
| Cursor | `cursor.com/docs/context/mcp` |
| JetBrains AI Assistant | `jetbrains.com/help/ai-assistant/mcp.html`, `.../settings-reference-mcp.html` |
| JetBrains Junie | `junie.jetbrains.com/docs/junie-ide-plugin.html`, `.../junie-cli-mcp-configuration.html` |
| JetBrains Air | `jetbrains.com/help/air/mcp-servers.html` |
| VS Code | `code.visualstudio.com/docs/agent-customization/mcp-servers`, `.../reference/mcp-configuration` |
| GitHub Copilot | `docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp` |
| Google Antigravity | `antigravity.google/docs/mcp` |
| Cline | `docs.cline.bot/mcp/mcp-overview` |
| Kilo Code | `kilo.ai/docs/automate/mcp/using-in-kilo-code`, `.../mcp/server-transports` |
| Claude | `code.claude.com/docs/en/mcp`, `claude.com/docs/connectors/building/authentication`, `support.claude.com/en/articles/11175166` |
| OpenCode | `opencode.ai/v2/docs/mcp-servers`, `opencode.ai/docs/mcp-servers/` |
| Empryo | `empryo.com/docs/tools/mcp`, `empryo.com/docs/reference/configuration` |
| Mistral | `docs.mistral.ai/vibe/code/cli/mcp-servers`, `docs.mistral.ai/studio/connectors`, `docs.mistral.ai/vibe/work/connectors/mcp-connectors` |
| Gemini | `geminicli.com/docs/tools/mcp-server/`, `ai.google.dev/gemini-api/docs/antigravity-agent`, `support.google.com/gemini/answer/17209137` |
