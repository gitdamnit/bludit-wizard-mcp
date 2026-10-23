# MCP client compatibility

## Status: OpenCode verified for local stdio; hosted transports unverified

**OpenCode 2.0.21 has been driven end to end against the local stdio edition**:
`initialize`, `tools/list`, all nineteen `tools/call` operations, read and write
workflows, error propagation, and restart behaviour. See
[`LIVE_ACCEPTANCE_REPORT.md`](./LIVE_ACCEPTANCE_REPORT.md).

**No client has been verified against the hosted HTTP transports.** For those,
this document records what is implemented, what has been tested, and what each
claim would require — not a compatibility matrix of verified clients, because
claiming that would be false.

### What *has* been verified

A purpose-built client in the test harness
(`test/harness/oauth-client.ts`) completes the full path, end to end, in real
workerd:

```
401 challenge → RFC 9728 protected-resource metadata
              → RFC 8414 authorization-server metadata
              → Dynamic Client Registration (RFC 7591)
              → PKCE (S256) authorization request
              → sign-in and consent
              → authorization code exchange (RFC 6749)
              → MCP initialize
              → tools/list
              → tools/call
              → 403 scope step-up and re-authorization
              → refresh token exchange
              → token revocation
```

That client follows the specifications rather than being written around this
server's quirks, and where it had to change to make a test pass, the protocol
surface changed with it. It is real evidence that the server speaks the protocol.
It is not evidence that any particular product does.

### Why this matters

The temptation in a project like this is to list six well-known clients as
supported and move on. Every one of those lists is a guess until someone actually
connects the client. Client-side quirks — how a client renders a consent redirect,
whether it retries a `403` with more scope, whether it tolerates a stateless
server with no `Mcp-Session-Id` — only surface in practice.

## Target clients

| Client | Priority | Status | What it needs that this server provides |
|---|---|---|---|
| ChatGPT (developer mode / connectors) | primary | **unverified** | HTTPS remote MCP endpoint, OAuth discovery, DCR or CIMD |
| Codex | primary | **unverified** | Streamable HTTP, OAuth 2.1 with PKCE |
| Claude (web / Desktop / Code) | primary | **unverified** | Remote MCP with OAuth; the stdio path uses `src/index.js` |
| Gemini CLI | primary | **unverified** | Remote MCP; the stdio path uses `src/index.js` |
| OpenCode | primary | **unverified** | Remote MCP with OAuth |
| Cursor | secondary | **unverified** | Remote MCP; also registers private-use redirect URIs |
| VS Code / GitHub Copilot | secondary | **unverified** | Remote MCP with OAuth |
| Kilo Code | secondary | **unverified** | Remote MCP |
| Windsurf | secondary | **unverified** | Remote MCP |
| Continue | secondary | **unverified** | Remote MCP |

Nothing in this table is a compatibility claim. It is a list of what to test.

## Protocol surface implemented

Built on `@modelcontextprotocol/sdk` 1.32.1 and
`@cloudflare/workers-oauth-provider` 1.2.3, which implement the MCP
authorization specification dated 2026-07-28.

### Transport

| Feature | Implemented | Notes |
|---|---|---|
| Streamable HTTP `POST /mcp` | ✅ | Stateless: `sessionIdGenerator: undefined` |
| JSON responses | ✅ | `enableJsonResponse: true` |
| SSE responses | ✅ | Supported by the SDK transport |
| Session IDs | ❌ intentionally | Stateful sessions would need Durable Objects for no benefit here |
| `GET /mcp` stream | ⚠️ | Stateless mode has no server-initiated stream; the transport answers 405 |
| `DELETE /mcp` | ⚠️ | No session to terminate |

A client that *requires* an `Mcp-Session-Id` will not work. None of the target
clients is documented to.

### Authorization

| Feature | Implemented |
|---|---|
| RFC 9728 protected-resource metadata | ✅ |
| RFC 8414 authorization-server metadata | ✅ |
| OAuth 2.1 Authorization Code | ✅ |
| PKCE, `S256` required | ✅ |
| Refresh tokens with idle expiry | ✅ |
| Token revocation (RFC 7009) | ✅ |
| Dynamic Client Registration (RFC 7591) | ✅ |
| Client ID Metadata Documents | ✅ (requires `global_fetch_strictly_public`, which production sets) |
| Scope step-up via `403 insufficient_scope` | ✅ |
| RFC 8707 resource indicators | ✅ |
| RFC 9207 `iss` in the authorization response | ✅ |
| `429` with `Retry-After` on every public entry point | ✅ |
| Private-use redirect URIs (RFC 8252) | ❌ by default; `allowPrivateUseRedirectUris` is off. A client that *only* offers one cannot be used unless that option is enabled. |

### Tools

| Feature | Implemented |
|---|---|
| `tools/list` | ✅ 19 tools |
| `tools/call` | ✅ |
| Tool `title`, `description`, `inputSchema` | ✅ |
| Tool `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) | ✅ on every tool |
| `outputSchema` | ❌ not declared |
| Tool-result `annotations` | ❌ not used |
| Resources / prompts | ❌ not implemented |

## How to verify a client

Do this per client, and record the result honestly. Do not mark a client verified
from documentation.

### Static prerequisites

- The client supports **remote** (HTTP) MCP servers. Several support only stdio,
  in which case they should use `src/index.js` (single site, no OAuth) instead of
  this service.
- The client supports OAuth 2.1 with PKCE for a remote MCP server, either through
  discovery or with manually configured client credentials.
- The client can reach a public HTTPS endpoint.

### The verification procedure

1. Deploy to a development hostname. Use a disposable Bludit site.
2. In the client, add the server by URL: `https://<host>/mcp`.
3. Confirm the client discovers `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server`. Many clients log the discovery step;
   check that the issuer and resource match your configuration.
4. Confirm the client registers (DCR) or presents a CIMD URL, and that the
   consent page opens in a browser with the client name and redirect host shown.
5. Approve a **read-only** scope set first.
6. Run `tools/list`. Confirm the client displays 19 tools and their descriptions.
7. Call `list_sites`. Confirm the connected site appears.
8. Call `list_pages`, then `get_page` for one page.
9. Attempt `create_page` with the read-only token and confirm the client handles
   the `403`: either it re-authorizes for more scope, or it reports clearly that
   more permission is needed. **This is the step most likely to differ between
   clients** and the most valuable to record.
10. Approve the write scope and call `create_page` for a draft.
11. Call `propose_page_edit` then `apply_approved_edit`.
12. Revoke the client from `/clients` and confirm subsequent calls fail with
    `401` and that the client prompts to re-authorize.

### What to record

- Client name and exact version.
- Date, and the git commit and deployment of this server.
- Whether discovery, DCR, CIMD, PKCE, consent, step-up and revocation worked.
- Any client-side error text.
- Whether the client required a manual client ID or secret (some do), and if so
  whether it was registered via `/oauth/register` or in the dashboard.
- Screenshots or a log excerpt, stored outside this repository.

## Compatibility hazards to watch for

| Hazard | Why | Where it would show |
|---|---|---|
| A client expecting stateful sessions | This server is stateless by design | Requests fail with a session error |
| A client caching `tools/list` aggressively | Scopes change between authorizations but the tool list does not | A newly granted tool is not offered |
| A client that cannot handle a `403` mid-conversation | Scope step-up requires re-authorization | The write appears to fail silently |
| A client that validates the tool schema strictly | `inputSchema` is generated from Zod; all fields are optional for tools whose requirements are enforced server-side | `create_page` without `title` shows a tool error rather than a schema error |
| A client whose `client_name` is empty | The consent page falls back to the client id | The user sees an opaque identifier — expected, and documented |
| A client that requires `outputSchema` | Not declared | No structured output consumption |
| A client that does not back off on `429` | Every public entry point is rate limited | Repeated calls return `429` with `Retry-After`; a client that ignores it gets no results until the window resets |

## stdio clients

Clients that only speak stdio are supported through the retained upstream server,
`src/index.js` (`npm run start:stdio`). It reads one site from environment
variables, serves one user, and exposes six tools including `delete_page`.

This path is **also unverified** against a live client in this work. It is the
upstream code at its pinned commit, so whatever compatibility it had upstream is
unchanged — but that is an argument from provenance, not from testing.

## A note on the live Bludit verification

24 tests now pass against real Bludit Community and Pro installations. That is
evidence about the **CMS integration**, not about any MCP client: those runs drive
the server through the same harness client described above. It does not change a
single row in the target-client table.

It is worth stating because it is exactly the kind of result that gets
over-claimed. "Verified against live Bludit" is true. "Works with ChatGPT" is not.

## What is safe to publish today

- "Implements MCP Streamable HTTP and OAuth 2.1 per the 2026-07-28 specification."
- "Verified end to end against a specification-following client in automated
  tests running in workerd."
- "Verified against live Bludit Community and Pro 3.22.0 installations."
- "Not yet verified against any specific MCP client product."

What is **not** safe to publish, and must not be claimed anywhere:

- "Works with ChatGPT / Claude / Cursor / …" — until step 9 above has been taken
  for that client and recorded.
- A compatibility badge, tick, or logo for any client.
