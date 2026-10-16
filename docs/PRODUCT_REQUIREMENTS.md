# Product requirements

Status: **pre-release, not deployed.** Every status column below is backed by
something in this repository — a test, a document, or a commit. Where a
requirement is not met, it says so.

Legend: ✅ met · ⚠️ met with a stated limitation · ❌ not met · ⛔ blocked on an
approval or an external dependency.

## 1. Purpose

A universal remote MCP server that lets standards-compliant AI clients read,
draft and update pages on Bludit websites that a user has connected to their own
account, without the server running inference or storing page content.

## 2. Publication objectives

| # | Objective | Status |
|---|---|---|
| O1 | Publish the native Bludit Wizard PHP plugin in Bludit's plugin repository | ⛔ separate project; not modified here |
| O2 | Publish Bludit Wizard MCP as a public plugin in OpenAI's directory | ⛔ prepared, not submitted; 14 blocking items |
| O3 | Showcase both on a portfolio site | ⛔ separate objective |

This assignment concerns O2 while preserving interoperability with O1.

## 3. Non-negotiable principles

| # | Principle | Status | Evidence |
|---|---|---|---|
| P1 | Universal remote MCP server, not a ChatGPT-specific backend | ✅ | Stateless Streamable HTTP + OAuth 2.1; no client-specific code paths |
| P2 | Standards-compliant MCP clients via Streamable HTTP and OAuth 2.1 | ✅ | RFC 9728, 8414, 6749, 7591, 7636, 7009, 8707, 9207; verified by a specification-following client |
| P3 | Primary clients: ChatGPT, Codex, Claude, Gemini CLI, OpenCode | ❌ **unverified** | None has been connected. See `CLIENT_COMPATIBILITY.md` |
| P4 | Secondary: Cursor, VS Code, Kilo Code, Windsurf, Continue | ❌ **unverified** | As above |
| P5 | Never claim a client is compatible until actually verified | ✅ | No claim is made anywhere; the rule is in `CONTRIBUTING.md` |
| P6 | One hosted service supports multiple independently authorized websites | ✅ | Tenancy tests; MCP requests are scoped by account and client |
| P7 | Authentication, user identity, client identity, site ownership and tool authorization stay distinct | ✅ | Four separate concepts in `ARCHITECTURE.md`, each tested |
| P8 | The native PHP Wizard keeps working with BYOK providers | ✅ | Not modified; independence documented in `PHP_WIZARD_INTEGRATION.md` |
| P9 | The hosted MCP must not require an LLM provider or run inference | ✅ | No provider key, no model call in `src/` |
| P10 | Do not build an autonomous agent | ✅ | Tools act only when called, with explicit write paths |
| P11 | No mandatory dependency on the PHP plugin for basic API operations | ✅ | Every core tool works through the official API alone |
| P12 | Detect the companion PHP extension and return capability information | ✅ | `get_site_capabilities`; Wizard pairing path tested against a faithful mock |
| P13 | Preserve upstream licence notices and attribution | ✅ | Dual-copyright `LICENSE`, `NOTICE`, upstream history intact |
| P14 | No production credentials, website content, or secrets in source control | ✅ | Asserted by `test/unit/production-config.test.ts` |
| P15 | No production deployment, DNS or account change without approval | ✅ | No deploy step in CI; seven approval gates in `DEPLOYMENT.md` |

## 4. Functional requirements

### 4.1 MCP tools

| # | Requirement | Status | Evidence |
|---|---|---|---|
| FR-1 | `get_website_settings` | ✅ | Live-verified on both editions |
| FR-2 | `list_pages` | ✅ | Live-verified |
| FR-3 | `get_page` | ✅ | Live-verified, including a stable revision |
| FR-4 | `create_page` | ✅ | Live-verified |
| FR-5 | `edit_page` | ✅ | Live-verified, including key change on slug change |
| FR-6 | Keep `delete_page` omitted from public exposure | ✅ | Not registered; a test asserts it cannot reappear |
| FR-7 | `list_sites`, explicit site targeting | ✅ | `list_sites`, `select_site`, and a `site` argument on every tool |
| FR-8 | `get_site_capabilities` | ✅ | Live-verified on both editions |
| FR-9 | `search_pages` | ⚠️ | Works, but it is server-side substring filtering: Bludit has no search endpoint |
| FR-10 | `list_categories`, `list_tags` | ✅ | Live-verified; the draft-indexing rule is disclosed in the tool description |
| FR-11 | `get_drafts`, `get_scheduled_pages` | ✅ | Live-verified for drafts; scheduled pages covered by the mock and the API contract |
| FR-12 | `propose_page_edit`, `preview_page_changes`, `apply_approved_edit`, `verify_page_update` | ✅ | Live-verified end to end, including stale-approval refusal |
| FR-13 | `get_content_summary`, `get_related_pages` | ✅ | Live-verified; deterministic, no inference |
| FR-14 | Verify whether the API supports each new operation before implementing | ✅ | `PHP_WIZARD_INTEGRATION.md` and `BLUDIT_COMPATIBILITY_MATRIX.md` |
| FR-15 | Do not create artificial tools to inflate the catalogue | ✅ | 19 tools, each with a stated kind; no filler |
| FR-16 | Leave model-dependent reasoning to the client | ✅ | No inference on the server |
| FR-17 | Proposals are short-lived, account-bound, site-bound, immutable, with revision checks | ✅ | `proposals` schema; stale and cross-account application both refused |
| FR-18 | Enforce write authorization on the server, not in prompt text | ✅ | Scope checks in the HTTP pre-flight and inside every tool |
| FR-19 | Follow current OpenAI tool metadata, annotations and safety requirements | ⚠️ | Titles, descriptions and all four annotation hints on every tool; the plugin guidelines page has not been reviewed |

### 4.2 Authentication and authorization

| # | Requirement | Status | Evidence |
|---|---|---|---|
| FR-20 | OAuth discovery metadata | ✅ | RFC 8414 + RFC 9728 |
| FR-21 | Authorization Code with PKCE | ✅ | `S256` required; missing verifier refused |
| FR-22 | Client registration and discovery, including CIMD and DCR | ✅ | Both enabled; CIMD needs `global_fetch_strictly_public`, which production sets |
| FR-23 | Per-user identities | ✅ | Accounts in D1, distinct from Bludit users |
| FR-24 | Per-client grants | ✅ | Revoking one client leaves others working |
| FR-25 | Consent and scope handling | ✅ | Consent page shows client, redirect host and scopes; fewer scopes may be granted |
| FR-26 | Token validation | ✅ | Audience-checked over a private Service Binding |
| FR-27 | Refresh tokens and expiration | ✅ | Idle expiry; refresh after revocation refused |
| FR-28 | Token revocation | ✅ | Per-grant, from the account UI |
| FR-29 | Reconnect and disconnect workflows | ✅ | Revoke and re-authorize; both tested |
| FR-30 | Secure session handling | ✅ | `__Host-` cookie, `HttpOnly`, `SameSite=Lax`, stored as an HMAC, bound to the user agent |
| FR-31 | Least-privilege tool authorization | ✅ | Per-tool scopes; the consent page defaults write access to on but lets a user decline it |
| FR-32 | Individual website access restrictions | ✅ | Every lookup scoped by account |
| FR-33 | Protection against redirect manipulation, CSRF, replay and token leakage | ✅ | Unregistered redirect URI refused; CSRF derived from the session; code replay refused; tokens never logged |
| FR-34 | A user authorizing one client must not authorize another | ✅ | Approvals are bound to client, redirect URI, resource and account |
| FR-35 | The OAuth service must authenticate real users, not treat a site URL or API token as proof | ✅ | Three independent requirements; a pasted token alone connects nothing |
| FR-36 | A secure site-connection flow | ✅ | Single-use pairing challenge plus site-side proof |
| FR-37 | Never fetch arbitrary third-party URLs without validation | ✅ | SSRF policy, redirect revalidation, response bounds, and the runtime flag |
| FR-38 | Credentials encrypted at rest with separately managed secrets, never logged or returned | ✅ | AES-256-GCM; asserted against real D1 rows; every tool output scanned for plaintext |
| FR-39 | Rate limiting on OAuth, registration, pairing and MCP | ✅ | Implemented and tested (42 tests); see `SECURITY.md` |

### 4.3 Native PHP independence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| FR-40 | Usable with a user-supplied key, configurable base URL, model and provider | ✅ | Unchanged PHP plugin |
| FR-41 | No requirement for ChatGPT, this server, a Cloudflare account, OAuth registration or developer inference | ✅ | Unchanged PHP plugin |
| FR-42 | Document the optional relationship without coupling | ✅ | `PHP_WIZARD_INTEGRATION.md` |
| FR-43 | Do not modify the PHP repository | ✅ | Not modified; nothing copied |
| FR-44 | Where an interface is missing, document a proposed contract rather than inventing it | ✅ | Four proposed contracts |

### 4.4 Bludit edition support

| # | Requirement | Status | Evidence |
|---|---|---|---|
| FR-45 | Support Bludit Community and Pro where the APIs and capabilities exist | ✅ | Live-verified on both; no feature is gated by edition |
| FR-46 | Do not assume Pro-only functionality exists in Community | ✅ | Capabilities are probed, never assumed; both editions verified identical |
| FR-47 | Do not restrict features that work in both | ✅ | A test asserts identical tool behaviour across editions |
| FR-48 | Compatibility across supported Bludit versions, not just 3.22.0 | ⚠️ | 3.22.0 live-verified; later 3.22.x patches are modelled, not live-tested. Below 3.22 is out of scope |

## 5. Non-functional requirements

| # | Requirement | Status | Evidence |
|---|---|---|---|
| NFR-1 | Reliability: a write is never reported as successful unless confirmed | ✅ | Every write reads the page back and returns `verified: true` |
| NFR-2 | Reliability: no silent failure | ✅ | Stable error codes; an unexpected failure is logged with its message and returned as `internal_error` |
| NFR-3 | Security: no credential in a log, error, tool result or the repository | ✅ | Redacting logger, generic error mapping, and tests that scan real tool output |
| NFR-4 | Privacy: no page content stored; no IP or email stored | ✅ | Content is not persisted; rate-limit and session keys are HMACs |
| NFR-5 | Operability: cleanup of expired state | ✅ | `scheduled()` on both Workers purges sessions, challenges, proposals and counters |
| NFR-6 | Cost: a realistic, documented estimate | ✅ | $5/month minimum; the free tier is insufficient, for a stated reason |
| NFR-7 | No VPS, Docker dependency or always-on process | ✅ | Cloudflare Workers only |
| NFR-8 | Reproducibility: exact dependency pins | ✅ | Exact versions, committed lockfile |
| NFR-9 | Testability: the default suite needs no network, credentials or Docker | ✅ | 324 hermetic tests; live tests are opt-in and separate |
| NFR-10 | Observability sufficient to detect abuse | ⚠️ | Structured logs, audit table and `429` metrics; no alerting configured |
| NFR-11 | Accessibility and usability of the account UI | ⚠️ | Server-rendered, semantic HTML, no client-side JS dependency; not audited against WCAG |

## 6. Explicitly out of scope

Recorded so that their absence is a decision, not an oversight.

| Item | Reason |
|---|---|
| Page deletion | Irreversible in Bludit; see `SECURITY.md` |
| Image and file upload | No tool needs it; probing uploads would perform uploads |
| Editing site settings | Read-only settings tool only |
| User administration of Bludit | Would expose account records |
| Search implemented in the CMS | The API has no search endpoint |
| Embeddings or vector search | No inference and no content store |
| Billing, subscriptions, licensing servers, paywalls | Excluded by the brief; nothing to bill for |
| Password reset by email | Would require an email provider, which is a new external service and an approval |
| Multi-region replication | Not needed at the scale this is designed for |

## 7. Acceptance criteria for the first development deployment

A deployment is "ready" when every one of these holds. None currently does,
because nothing is deployed.

1. Both Workers deploy and `/healthz` returns `{ ok: true }`.
2. `/.well-known/oauth-authorization-server` reports the real issuer and
   `client_id_metadata_document_supported: true`.
3. `/.well-known/oauth-protected-resource` names the same issuer and the real
   resource identifier.
4. A fresh OAuth client completes discovery, registration, PKCE, consent and
   token exchange against the deployment.
5. A real Bludit site connects through the pairing flow, and `list_pages` returns
   its pages through the MCP endpoint.
6. Rate limits hold under a deliberate flood on the token endpoint, the
   registration endpoint and the MCP endpoint.
7. One named MCP client is verified end to end and the result recorded in
   `CLIENT_COMPATIBILITY.md`.
8. No secret appears in a Worker log, and `SITE_CREDENTIAL_KEY` is confirmed
   backed up outside Cloudflare.
9. `docs/PROJECT_STATUS.md` is updated with the deployment's commit, hostname and
   verification date.

## 8. Traceability

| Requirement group | Primary document |
|---|---|
| Product and principles | this document |
| Architecture and cost | `ARCHITECTURE.md` |
| Tools and scopes | `MCP_TOOLS.md` |
| Security and risk | `SECURITY.md` |
| Deployment and approval gates | `DEPLOYMENT.md` |
| Upstream provenance | `UPSTREAM_COMPARISON.md` |
| PHP integration | `PHP_WIZARD_INTEGRATION.md` |
| Edition and version support | `BLUDIT_COMPATIBILITY_MATRIX.md` |
| Client compatibility | `CLIENT_COMPATIBILITY.md` |
| Test evidence | `TEST_REPORT.md` |
| Publication | `OPENAI_PUBLICATION_CHECKLIST.md` |
| Decisions and their reasons | `DECISION_LOG.md` |
