# Project status

**Branch:** `feat/remote-mcp-oauth-v1`
**Head:** see the commit that last touched this file (`git log -1 -- docs/PROJECT_STATUS.md`)
**State:** implementation and testing complete; **not deployed**; no Cloudflare
resource created; nothing published.

## 1. Summary

| Area | State |
|---|---|
| Implementation | Complete: 19 MCP tools, OAuth 2.1 authorization server, resource server, site pairing, proposals, rate limiting |
| Hermetic test suite | **395 passing** across 23 files |
| Live test suite | **24 passing** against real Bludit Community 3.22.0 and real Bludit Pro 3.22.0 |
| Client compatibility | Twelve targets researched from official documentation; **none tested**. One `readOnlyHint`/`destructiveHint` gap and one `Accept`-header gap closed; a personal-access-token path added for the four surfaces that cannot do OAuth |
| Live compatibility | Verified, both editions |
| Type checking | Clean, with `noUnusedLocals` |
| Worker builds | Both bundle, well within the 64 MiB limit |
| Deployment | **Not started** — awaiting approval |
| Publication | Prepared, not submitted (14 blocking items) |

## 2. What is verified, and how

| Claim | Evidence |
|---|---|
| The OAuth flow works end to end | Discovery → DCR → PKCE → consent → token → `tools/list` → `tools/call` → scope step-up → refresh → revocation, driven by a specification-following client in real workerd |
| Multi-tenant isolation holds | Per-client and per-account tests; another account's site id, pages, capabilities and proposals all refused with `not_found` |
| Credentials are encrypted at rest | Read back out of real D1: ciphertext, no plaintext, distinct ciphertext for identical credentials on two sites, and every read tool's output scanned for the token |
| SSRF defence holds | Reserved ranges, IPv4-mapped/NAT64/6to4, obfuscated literals, internal hostnames, embedded credentials, scheme rules, redirect revalidation, response bounds |
| Rate limiting holds | 48 tests across eleven buckets, including window reset, per-client and per-account isolation, no PII in storage, a disabled-mode test, and that revocation is never throttled |
| The audit trail is complete and clean | `audit-review.test.ts`: one row per tool call for both credential types, a code rather than a message on failure, and no credential, page content or site label anywhere in it |
| The protocol surface matches what clients need | `protocol-surface.test.ts`: 19 tools each carrying all four annotation hints, `401` challenge shape, resource metadata, four `Accept` variants, old and new protocol revisions, no session id, no legacy `/sse` |
| The nine-step client journey works | `client-journey.test.ts` walks all nine steps twice, once per credential type |
| The token path is a credential, not a bypass | `pats.test.ts`: same scope enforcement, same tenancy, no delete, review-before-write, immediate revocation, expiry enforced, no plaintext stored, per-token audit |
| The tool catalogue works on real Bludit | **24 live tests**, 14 operations each, on Community and Pro |
| Community and Pro are equivalent for this server | `bl-plugins/api/plugin.php` and every kernel file the API depends on are **byte-identical** between the two 3.22.0 trees, and both live runs produce identical results |
| Production configuration is safe | `test/unit/production-config.test.ts` asserts the deployable configs set the SSRF flag, disable insecure site URLs, keep rate limiting on, carry no secret, agree on issuer and resource, and contain no route |

## 3. Defects found during this work

Fifteen, all fixed and all with regression tests. The four most recent were found
by the pre-deployment rate-limit audit, and one of them is the most serious
functional finding in the project:

| Severity | Finding |
|---|---|
| **High** | Four expensive or sensitive endpoints were entirely unprotected: `POST /signup`, `POST /tokens`, `POST /authorize/decision`, `POST /sites/:id/check`. `/signup` needs no credential and runs PBKDF2 plus a write, making it a CPU and storage abuse vector. `/sites/:id/check` makes four or five outbound requests to a customer's own site. |
| Medium | The MCP limit was per client only, so an account with many authorized clients got a fresh budget per client against the same CMS. |
| Medium | No audit-logging test existed, so the completeness and cleanliness of the trail was an assumption. |

The first eleven are below. Nine are in `SECURITY.md`; the
three below were found by live testing and are the most instructive:

| Severity | Finding | How it surfaced |
|---|---|---|
| High | `tags` is a comma-joined **string** on the wire, not an array. `search_pages` and `get_related_pages` called `.some()` on it, which threw and returned `internal_error` on a real site. `summarizePage` silently returned an empty tag list for every page. | First live run. The mock returned an array, so the hermetic suite passed while the live behaviour was broken. |
| Medium | `category` is `false`, not a string, when a page has no category — including when a page was stored with a category the site does not define. `search_pages` threw `false.toLowerCase is not a function`. | Same live run, after fixing tags. |
| Medium | Bludit indexes tags only for published, static and sticky pages, so a draft's tags never appear in `list_tags`. | Same live run; the tool description and the compatibility matrix now state the rule. |

The lesson is recorded as ADR-013: a mock disagreeing with a live site is a mock
defect first, and all three now reproduce faithfully in the mock.

## 3a. Client compatibility

Twelve named environments, several resolving to more than one client surface. Full
detail in `CLIENT_COMPATIBILITY_MATRIX.md`; the analysis is in
`CLIENT_GAP_ANALYSIS.md`.

| Outcome | Count | Surfaces |
|---|---|---|
| Served by OAuth alone, no adapter | 17 | Codex, Cursor, Junie CLI, JetBrains Air, VS Code, Copilot CLI, Antigravity, Cline, Kilo Code, Claude Code, Claude Desktop, Claude web, OpenCode V1 and V2, Le Chat, Gemini CLI, Gemini apps |
| Served with a pre-registered OAuth client | 2 | Mistral AI Studio, Gemini Enterprise |
| Served with a personal access token | 4 | Copilot cloud agent, Copilot code review, Mistral Vibe Code CLI, Empryo |
| Unverified — documentation does not say | 2 | JetBrains AI Assistant remote auth, Codex Cloud |
| Not supported | 1 | Junie IDE plugin (documents no token support) |
| Not applicable | 1 | "Mistral Code" (no official MCP documentation under that name) |

**Nothing is claimed as tested.** Every "tested version" cell in the matrix says
`not tested`. What is verified is that the server satisfies each documented client
requirement that could be identified, and that the nine-step journey works for both
credential types.

Three changes were needed, and no more:

1. `destructiveHint` added to the 13 read-only tools, because Claude requires both
   annotation hints on every tool.
2. `withTolerantAccept()`, because the transport returned `406` for any `Accept`
   header other than the exact specification-compliant combination.
3. Personal access tokens, because four client surfaces cannot present an OAuth
   token at all.

The tool layer, the transport, the authorization service, the tenancy model and
both safety safeguards needed **no** change. No client required a stdio bridge:
every remote surface among the twelve documents native remote MCP support.

## 4. Remaining accepted risks

Full reasoning in `SECURITY.md`. None of these blocks a **development**
deployment; the ones marked *public* must be closed before a public launch.

| Risk | Blocks a dev deployment? | Blocks a public launch? | Note |
|---|---|---|---|
| No MFA on service accounts | No | **Yes** | Account takeover is website takeover. Email and password only today. |
| No password reset by email | No | **Yes** | A user who forgets a password has no route back in. Needs an email provider — a new external service and an approval. |
| No alerting on `429`s or anomalies | No | Yes | Metrics exist in the dashboard; nothing pages anyone. |
| Credential key rotation unimplemented | No | Yes | A suspected key compromise currently means reconnecting every site. `CREDENTIAL_KEY_VERSION` is recorded so staged rotation is possible. |
| KV eventual consistency on revocation | No | No | Bounded by the one-hour access-token TTL and typically under 60 seconds. |
| Both Workers share `SITE_CREDENTIAL_KEY` | No | No | Required for the resource server to decrypt; splitting it means proxying every CMS call. |
| No verification against a real MCP client | No | **Yes** | The protocol is verified and twelve clients are researched against official documentation, but no product has been connected. Still the largest gap in the publication case. |
| A personal access token is a long-lived bearer credential | No | No | Bounded by user-chosen scopes, 90-day default expiry, immediate revocation, per-token audit, and no delete capability. ADR-020 records the trade-off. |
| Client documentation may understate strictness | No | Yes | Other clients may be as strict as Claude without saying so. Only testing settles it. |
| Only 3.22.0 live-verified | No | No | Later 3.22.x patches are modelled; below 3.22 is out of scope. |
| `get_website_settings` needs an admin auth token | No | No | Bludit's own rule, disclosed in the capability report. |
| No `/.well-known/security.txt` | No | No | Nice to have for coordinated disclosure. |
| Wizard pairing contract is proposed, not implemented in PHP | No | No | The ownership-file path is complete and plugin-free. |

## 4a. Deployment readiness

The full gate is [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md): exact
resource list, a $5/month cost breakdown, the remaining risks split by what they
block, and the ordered deploy sequence for temporary `workers.dev` endpoints.

Summary: **1 KV namespace, 1 D1 database, 2 Workers, 3 secrets, one shared value.**
No DNS change. Workers Paid is required, because sign-in exceeds the free plan's
10 ms CPU allowance and returns error 1102.

## 5. What the first development deployment requires

Nothing here is done yet. In order.

### 5.1 Your decisions

1. **The hostname.** `mcp.evanzellner.com` is assumed throughout. Confirm it, or
   name another. It must be an `https` origin; the OAuth library accepts plain
   http only on loopback.
2. **Approval to create Cloudflare resources**: one KV namespace and one D1
   database, both on the free tier initially.
3. **The Workers Paid plan** ($5/month), which `ARCHITECTURE.md` shows is required
   — password hashing exceeds the free tier's 10 ms CPU allowance and its 1,000 KV
   writes per day cannot carry OAuth grants.
4. **Approval to deploy** two Workers, and later to add a DNS record.
5. **A decision on `ALLOW_SIGNUP`.** Open by default, and rate limited, but
   there is no invite-only mode yet.

### 5.2 Secrets to generate and store

Three, all generated locally, two of them stored in a password manager because
Wrangler cannot read a secret back.

| Secret | Scope | If it is lost |
|---|---|---|
| `SITE_CREDENTIAL_KEY` | both Workers, **same value** | Every connected site must be reconnected; stored credentials become undecryptable |
| `SESSION_SECRET` | auth | All sessions and CSRF tokens invalidated, outstanding pairing challenges die |
| `CONSENT_SECRET` | auth | Remembered consents forgotten; users are re-prompted |

### 5.3 Commands, in order

```bash
# 1. Resources (approval gate)
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create bludit-wizard-mcp
# paste the ids into wrangler.auth.jsonc and wrangler.mcp.jsonc

# 2. Real hostnames in both configs
#    AUTH_ISSUER=https://<host>   MCP_RESOURCE=https://<host>/mcp

# 3. Secrets (approval gate)
npx wrangler secret put SITE_CREDENTIAL_KEY --config wrangler.auth.jsonc
npx wrangler secret put SESSION_SECRET        --config wrangler.auth.jsonc
npx wrangler secret put CONSENT_SECRET        --config wrangler.auth.jsonc
npx wrangler secret put SITE_CREDENTIAL_KEY   --config wrangler.mcp.jsonc

# 4. Schema (approval gate)
npx wrangler d1 migrations apply bludit-wizard-mcp --remote --config wrangler.auth.jsonc

# 5. Deploy — authorization server first, it owns the service binding target
npm run build:auth && npm run build:mcp
npx wrangler deploy --config wrangler.auth.jsonc
npx wrangler deploy --config wrangler.mcp.jsonc
# (approval gate)

# 6. Verify — commands in DEPLOYMENT.md, section "Verification after deploying"
```

### 5.4 What must be true before calling it done

The nine acceptance criteria in `PRODUCT_REQUIREMENTS.md` §7. In short: both
Workers healthy, discovery correct, a fresh client authorizes, a real Bludit site
connects and lists pages, rate limits hold under a deliberate flood, one named MCP
client is verified and recorded, no secret appears in a log, and the key is backed
up.

### 5.5 Immediately after that

1. Verify one real MCP client and record it in `CLIENT_COMPATIBILITY.md`. This is
   the highest-value outstanding task for both the OpenAI submission and the
   portfolio write-up.
2. Run the live suite against a **remote** Community and Pro install, so the
   compatibility evidence is not loopback-only.
3. Re-run `npm test` and `npm run test:live` and update `TEST_REPORT.md` with the
   deployment's commit.

## 6. How to reproduce everything locally

```bash
npm ci
npm run typecheck          # clean
npm test                   # 324 tests, hermetic: no network, no Docker, no credentials
npm run test:browser       # 9 browser tests
npm run build:auth && npm run build:mcp

# Live: real Bludit Community, and Pro if you point PRO_ZIP at the archive
PRO_ZIP=/path/to/bludit-pro-3.22.0.zip scripts/live-bludit-up.sh both
npm run test:live          # 24 tests against the real installations
scripts/live-bludit-up.sh --down
```

Docker is used **only** for the live Bludit installations. Nothing in the
production path depends on it.

## 7. Artifacts

| Path | Contents |
|---|---|
| `reports/junit.xml` | Vitest results |
| `reports/playwright-junit.xml` | Browser test results |
| `reports/live-junit.xml` | Live Bludit results |
| `reports/bludit-compatibility.json` | Modelled variant results |
| `reports/bludit-live-compatibility.json` | Live results (also in `docs/evidence/`) |
| `reports/live-bludit-credentials.json` | Throwaway loopback credentials, git-ignored |
| `reports/coverage/` | V8 coverage, with the caveat explained in `TEST_REPORT.md` |

`reports/` is git-ignored build output. The two compatibility JSONs are copied to
`docs/evidence/` because the documentation cites them.

## 8. Note on unrelated resources

A `docker ps` during this work shows five containers named `bwtest-*`
(`bwtest-community-1` on 8081, `bwtest-pro-1` on 8082, `bwtest-subdir-1` on 8083,
`bwtest-nokey-1` on 8084, `bwtest-mockai-1` on 8090). They belong to another
project and were left untouched. The live test work here uses its own containers,
`bludit-live-community` (8801) and `bludit-live-pro` (8802).
