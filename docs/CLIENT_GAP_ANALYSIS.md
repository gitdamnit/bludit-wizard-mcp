# Client compatibility gap analysis

Produced before any implementation, against the twelve target client environments.
It answers one question: **what does the existing 19-tool implementation already
support, and what genuinely requires new work?**

The answer is that most of the requirement needs no code at all, and the parts
that did turned out to be three small, specific things rather than a rebuild.

All client facts below come from official vendor documentation fetched on
2026-10-16, cited per client in `CLIENT_COMPATIBILITY_MATRIX.md`.

## 1. What already existed, before this requirement

| Capability | Status before | Evidence |
|---|---|---|
| Remote MCP over Streamable HTTP | Present | `src/mcp/app.ts`, verified in `test/integration/protocol-surface.test.ts` |
| OAuth 2.1 with discovery (RFC 9728 → 8414) | Present | `src/auth/oauth.ts`; `oauth-security.test.ts` |
| PKCE (S256), refresh, revocation | Present | Same |
| Dynamic Client Registration (RFC 7591) | Present | `clientRegistrationEndpoint`; a test registers clients |
| Client ID Metadata Documents (CIMD) | Present | Advertised when the production compatibility flag is set; asserted in `production-shape.test.ts` |
| Pre-registered OAuth client | Present | The authorization server accepts any registered `client_id` |
| `401` challenge with `resource_metadata` | Present | `protocol-surface.test.ts` |
| Multi-tenant isolation by account, grant, scope and site | Present | `security-controls.test.ts`, 12 cross-account probes |
| No-delete-by-agent | Present | No delete tool exists; asserted in three suites |
| Review-before-write | Present | `propose_page_edit` → `apply_approved_edit` with a revision pin |
| 19 tools with titles, descriptions and JSON Schema inputs | Present | `tools/list` asserted in `protocol-surface.test.ts` |
| Rate limiting on every public entry point | Present | `rate-limit.test.ts` |
| Native PHP Wizard, independent and BYOK, untouched | Present | `PHP_WIZARD_INTEGRATION.md`; not modified |

**Therefore the tool layer, the transport, the authorization server, the tenancy
model and both safety safeguards needed no change for this requirement.** Nothing
here was rebuilt to satisfy it.

## 2. What the research found about the twelve targets

The twelve names resolve to more distinct client surfaces than they first appear
to, and the requirement asks for that distinction explicitly.

| Client | Surfaces that matter | Remote MCP documented | Auth documented |
|---|---|---|---|
| OpenAI Codex | Codex CLI, IDE extension, desktop app (shared MCP config); Codex Cloud is separate | Yes | OAuth (CIMD **and** DCR), bearer env var, static headers |
| Cursor | one product | Yes | OAuth (DCR default), static headers, pre-registered client |
| JetBrains | AI Assistant; Junie IDE plugin; Junie CLI; Air; Central Console | Yes, except Junie IDE plugin | AI Assistant remote auth **undocumented**; Junie IDE plugin documents **no token support** |
| VS Code / GitHub Copilot | VS Code agent mode; Copilot cloud agent; Copilot code review; Copilot CLI | Yes | VS Code: OAuth (DCR). **Copilot cloud agent and code review: OAuth not supported, static headers only** |
| Google Antigravity | one product | Yes | OAuth (auto-DCR) or pre-registered client, Google ADC, static headers |
| Cline | one product | Yes | OAuth (browser), static headers; registration mechanism undocumented |
| Kilo Code | one product | Yes | OAuth 2.0 (auto), static headers; registration mechanism undocumented |
| Claude | Claude Code; Claude Desktop; Claude web connectors/Cowork | Yes | OAuth (DCR **and** CIMD), static headers (beta), none |
| OpenCode | V1 and V2 config shapes differ | Yes | OAuth 2.1 (CIMD, DCR, pre-registered), static headers |
| Empryo | one product | Yes | **static headers only; OAuth not documented** |
| Mistral | Studio Connectors; Le Chat; **Vibe Code CLI**; ("Mistral Code" has no MCP docs) | Yes | Le Chat: OAuth + DCR. Studio: pre-registered client. **Vibe Code CLI: OAuth explicitly not supported** |
| Gemini | Gemini CLI; Gemini API managed agents; Gemini consumer app; Gemini Enterprise | Yes | CLI: OAuth (DCR) + headers. API/consumer: headers or DCR. Enterprise: pre-registered client |

### The three findings that mattered

1. **Claude's shared connector client requires both `readOnlyHint` and
   `destructiveHint` on every tool.** Its documentation states this as a
   requirement, not a suggestion. Thirteen of the nineteen tools declared only
   `readOnlyHint`. **A real, blocking gap.**
2. **Three targets cannot complete an OAuth flow at all.** GitHub Copilot's cloud
   agent and code review "do not currently support remote MCP servers that
   leverage OAuth"; Mistral's Vibe Code CLI "does not yet support MCP servers that
   require OAuth authentication"; Empryo documents static headers only. Against an
   OAuth-only server they cannot connect. **A real, blocking gap.**
3. **No target documents a requirement for `Mcp-Session-Id`, a held-open `GET`
   stream, `outputSchema`, or a specific protocol revision.** Every such field in
   the research came back "Unknown — not stated in official docs". So the stateless
   transport needed no change.

## 3. Gaps that required work, and what was done

### Gap 1 — Tool annotations (small, blocking)

Claude requires `readOnlyHint` **and** `destructiveHint` on every tool; GitHub
Copilot code review requires `readOnlyHint: true` on any tool it may call.

**Done:** all 19 tools now declare all four hints. `destructiveHint: false` was
added to the 13 read-only tools. Asserted for every tool in
`test/integration/protocol-surface.test.ts`, so it cannot regress.

### Gap 2 — `Accept` header tolerance (small, blocking for some clients)

The transport refused with `406 Not Acceptable` unless the client sent exactly
`Accept: application/json, text/event-stream`. Measured before the fix:

| Accept sent | Status before | Status after |
|---|---|---|
| `application/json` | 406 | 200 |
| `application/json, text/event-stream` | 200 | 200 |
| `text/event-stream` | 406 | 200 |
| `*/*` | 406 | 200 |

The MCP specification does require clients to send the combined header, so a
conformant client was never broken. But a `406` is opaque, and the research shows
several clients implement only a subset.

**Done:** `withTolerantAccept()` in `src/mcp/app.ts` completes the header before
the transport sees it. It only widens what is accepted; the response is still a
single JSON body. Documented residual: a client that understands *only*
server-sent events is still not served, because `enableJsonResponse` is on.

### Gap 3 — A static credential path (the substantial one)

Four of the resolved client surfaces cannot present an OAuth token. Without a
header credential they cannot use this server, or any conforming remote MCP
server with OAuth.

**Done:** personal access tokens.

| Aspect | How |
|---|---|
| Ownership | Bound to one account; every site and proposal lookup stays scoped |
| Scope | The user chooses from the same catalogue; the baseline read scopes are always included |
| Lifetime | 90-day default, 365-day ceiling, enforced on every request |
| Revocation | A row update the next request observes — no propagation delay, unlike the OAuth KV path |
| Storage | SHA-256 digest only; the token is shown once and never stored |
| Authorization | Checked by **the same** code as an OAuth token: HTTP scope pre-flight, per-tool scope checks, tenancy, audit |
| Audit | Recorded as `pat:<id>`, so the trail shows which credential acted |
| Safety | No delete tool, and the review-before-write gate is unchanged — asserted with a token too |
| Secrets | None added. A 192-bit random token cannot be guessed offline, so an unkeyed digest suffices |

Sixteen integration tests and twelve unit tests, including that a token cannot see
another account's site, that a revoked or expired token stops working on the very
next request, and that no plaintext token exists anywhere in the database.

### Gap 4 — The nine-step journey, for both credential types

The requirement lists nine steps a client must be able to perform.
`test/integration/client-journey.test.ts` walks all nine twice — once with an
OAuth token, once with a personal access token — and asserts each result. That
walk is the evidence behind four columns of the compatibility matrix.

## 4. Gaps deliberately not filled

Recorded so their absence is a decision, with the reason.

| Not built | Why |
|---|---|
| **A stdio ↔ remote bridge** | No target client needs one. Every remote surface among the twelve documents native remote MCP, or a native connector (Claude Desktop). A bridge would be new code with no client to serve. The one stdio-only surface, the Junie IDE plugin, fails for a different reason — see below. |
| **Stateful sessions / Durable Objects** | No client documents requiring `Mcp-Session-Id`. Adding a Durable Object would introduce duration billing and cross-tenant state to solve nothing that is documented. |
| **SSE-only responses** | No client requires it, and JSON responses are friendlier. The residual risk is stated rather than hidden. |
| **`outputSchema`** | No client documents requiring it. Declaring one for 19 tools is real work with no demonstrated need. |
| **An `/sse` legacy endpoint** | Deprecated in the MCP specification. Four clients support it as a fallback, but all four prefer Streamable HTTP, and one (Gemini Enterprise) refuses SSE outright. |
| **Per-client backends** | Explicitly rejected by the requirement: one ecosystem, not twelve applications. |
| **CORS relaxation** | The resource server already reflects the requesting origin and sends no `Allow-Credentials`. No change needed. |
| **Changing the PHP Wizard** | Out of scope and forbidden. It remains a first-class independent product. |

## 5. Clients that remain unsupported, and precisely why

Honesty here is the point of the exercise.

| Surface | Status | Reason |
|---|---|---|
| **Junie IDE plugin** | **Unsupported** | Its own documentation states: "At the moment, Junie does not support security tokens in MCP configs." No credential mechanism means no authenticated server, over any transport. A bridge would not help. |
| **JetBrains AI Assistant remote auth** | **Unknown** | The MCP documentation shows a `url` and nothing else — no headers, no OAuth. Whether it performs OAuth discovery is not documented. It may work; nobody can say so without testing. |
| **Codex Cloud** | **Unknown** | Its documentation does not mention MCP at all. |
| **Mistral Code** | **Not applicable** | No official MCP documentation exists for a product under that name. Mistral's documented coding CLI is Vibe Code. |

## 6. How the twelve are served

| Approach | Client surfaces |
|---|---|
| **OAuth, no adapter** — point at the server URL | Claude Code; Claude Desktop and web connectors; Codex CLI/IDE/desktop; Cursor; Antigravity; Cline; Kilo Code; OpenCode; Gemini CLI; Gemini API managed agents; Gemini consumer app; Mistral Le Chat; VS Code; Copilot CLI; JetBrains Air; JetBrains AI Assistant (unverified) |
| **Pre-registered OAuth client** | Mistral Studio Connectors; Gemini Enterprise |
| **Personal access token** — the adapter for header-only clients | GitHub Copilot cloud agent; Copilot code review; Mistral Vibe Code CLI; Empryo; Claude's static-header option |
| **Not served** | Junie IDE plugin |

## 7. Residual risk

| Risk | Assessment |
|---|---|
| **No client has been tested.** | This is unchanged by any amount of research. What exists is a documented-capability match plus automated proof that the *server* supports each documented requirement. The matrix marks every cell "not tested" where it means the product. |
| A client is stricter than its documentation | Possible. The `401`-challenge and `authorization_servers` requirements are documented by Claude only; others may be equally strict without saying so. |
| A client sends a header shape the adapter does not anticipate | Low: the adapter only ensures both content types are offered, and it is verified for four variants. |
| A personal access token outlives its welcome | The token is a long-lived bearer credential in a client config file. Mitigated by scope, expiry, immediate revocation, per-token audit, and the absence of any delete capability. ADR-020 records the trade-off. |
| JetBrains AI Assistant may not support any remote auth | Unknown until tested. A URL-only configuration against this server returns `401`. |
