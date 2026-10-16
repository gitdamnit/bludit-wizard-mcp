# Node port feasibility — can Bludit Wizard MCP run on Node.js hosting?

**Status: companion study, and a correction.** This document was first written before
two facts were established elsewhere in this repository. Both are now known, and both
change what this document is for:

1. **The Hostinger plan is Premium Web Hosting**, prepaid to roughly November 2029.
   **Premium does not include Node.js.** Hostinger's Node.js web apps are available on
   **Business** and **Cloud** plans only. So the Node port analysed here is *not
   available on the existing plan at all* — not merely expensive. See
   [hosting/HOSTINGER_ANALYSIS.md](hosting/HOSTINGER_ANALYSIS.md) (Study B).
2. A **PHP adaptation** for Premium was analysed separately in
   [hosting/PHP_ADAPTATION_ANALYSIS.md](hosting/PHP_ADAPTATION_ANALYSIS.md), which
   concludes it is technically feasible but is "a second, security-critical codebase
   … with no shared tests", and not justified as a way to avoid $5/month. That
   document notes that "a Node port — if one is ever needed — reuses far more of the
   existing code than PHP would."

**This document quantifies that last claim.** It is the Node-port half of a comparison
the PHP study only asserted, and it is the analysis any future move off Cloudflare —
to Hostinger Business/Cloud, to a VPS, or to another Node host — would need.

**No source code was changed by this investigation.** Nothing was deployed, migrated,
or purchased.

## 1. The correction, stated plainly

My first version of this report said Node.js was available "if the plan is Business or
Cloud" and listed a Node port as an option. That was honest but incomplete: it left
open a question the user had already answered elsewhere. With Premium confirmed:

| Route on the existing plan | Available? |
|---|---|
| Run the Cloudflare Workers implementation on Hostinger Premium | ❌ Wrong runtime |
| Port to Node.js and run on Premium | ❌ **Premium has no Node.js** |
| Port to PHP and run on Premium | ⚠️ Technically possible; see the PHP study |
| Upgrade Premium → Business/Cloud for Node.js | 💰 Costs roughly what Cloudflare costs, so **no saving** |

So on the current plan there are exactly two candidates — a PHP rewrite, or nothing —
and the Node analysis below is **conditional**: it matters if the plan changes, if the
service ever moves to another Node host, or if the PHP port is weighed against one.

## 2. What actually ports, module by module

The finding worth keeping from the first version: the domain logic is genuinely
portable, and that is a credit to how the code was written. It is plain TypeScript
over `fetch` and WebCrypto — neither of which is Cloudflare-specific.

| Module | Ports to Node? | Note |
|---|---|---|
| `src/bludit/*` — client, capabilities, types | ✅ **unchanged** | `fetch` + WebCrypto only |
| `src/proposals/diff.ts` | ✅ unchanged | Pure functions |
| `src/shared/crypto.ts` | ✅ unchanged | WebCrypto; Node 22 has it natively |
| `src/shared/scopes.ts`, `html.ts`, `cookies.ts`, `redirect.ts`, `errors.ts`, `log.ts` | ✅ unchanged | Pure |
| `src/mcp/routing.ts`, `server.ts`, `tools/*` (all 19) | ✅ bodies unchanged | The DB handle changes type |
| `src/auth/app.ts`, `sites-ui.ts`, `tokens-ui.ts` — the whole UI | ✅ Hono runs on Node | But they call the Cloudflare OAuth library |
| `src/shared/pats.ts` | ⚠️ DB adapter | Uses the `D1Database` interface |
| `src/shared/rate-limit.ts` | ⚠️ DB adapter **and new SQL** | §4 |
| `src/sites/*`, `src/proposals/store.ts`, `src/audit/*` | ⚠️ DB adapter | `D1Database` → MySQL |
| `src/auth/accounts.ts`, `sessions.ts` | ⚠️ DB adapter | D1 → MySQL |
| `src/shared/ssrf.ts` | ⚠️ needs a compensating control | §5 |
| `src/auth/oauth.ts` | ❌ **must be replaced** | §3 — this is the crux |
| `src/auth/index.ts`, `src/mcp/index.ts` | ❌ replaced | Two Worker entrypoints become one app |
| `wrangler.*.jsonc`, `vitest.live.config.ts` harness | ❌ replaced | Hostinger app config; miniflare is Cloudflare-only |
| `test/harness/*` and the **428 tests** built on it | ❌ rebuilt | §6 |

**Roughly two thirds of the code is portable; the third that is not is the third that
makes the service safe.** The PHP study said a Node port reuses far more than PHP
would; this table is why, and it is a large margin — the PHP port rewrites all of
`src/bludit/**` and `src/mcp/tools/**` as well, which the Node port does not.

## 3. Replacing the Cloudflare OAuth provider — the crux

`@cloudflare/workers-oauth-provider@1.2.3` imports `WorkerEntrypoint` from
`cloudflare:workers` and stores clients, grants, authorization codes and tokens in a
KV namespace hard-coded as `OAUTH_KV`. It exposes no storage adapter, and it cannot
run on Node.

Everything it currently provides would have to be replaced:

- RFC 8414 authorization server metadata and RFC 9728 protected resource metadata
- Authorization Code with **PKCE `S256`**
- **Dynamic Client Registration** (RFC 7591), with the registration-policy callback
- **Client ID Metadata Documents**, and the `client_id_metadata_document_supported`
  advertisement that Claude, Codex and OpenCode look for
- Token issuance, **refresh with rotation and idle expiry**, RFC 7009 revocation
- Grant storage, consent transactions, remembered-consent cookies
- RFC 8707 resource indicators, RFC 9207 `iss`, audience binding

The realistic replacement is **`oidc-provider` (Panva)**, a mature Node authorization
server covering OAuth 2.1, PKCE, DCR, refresh rotation and revocation, with an
adapter you supply — so grants become MySQL rows. Three things it does **not** give
away, each security-critical and each needing its own tests:

- RFC 9728 protected-resource metadata and the `401` + `resource_metadata` challenge
- **CIMD**, which is not an OIDC feature
- The MCP `403` scope step-up, where one response names the **complete** required scope set

Hand-rolling the provider instead is not advisable. This is the single most
security-sensitive component in the project, and replacing its library is where the
Node port's risk concentrates.

## 4. Replacing D1, KV, Service Bindings and SQLite

**D1 → MySQL.** Mechanical for most of the schema: `TEXT`/`INTEGER` map directly,
`ON CONFLICT … DO UPDATE` becomes `INSERT … ON DUPLICATE KEY UPDATE`, `db.batch()`
becomes a transaction. One genuine snag and one reasoning change:

- The rate limiter's `INSERT … ON CONFLICT … DO UPDATE … RETURNING count` reads the
  counter back in a single atomic statement. **MySQL has no `RETURNING`.** It becomes
  two statements in a transaction, or the `LAST_INSERT_ID(expr)` trick. Small, but it
  is the one place where correctness is dialect-dependent.
- D1 is single-writer SQLite, which is exactly what made that counter atomic and
  globally consistent — the reasoning recorded in ADR-011. InnoDB is also fine here,
  but that decision would need restating for a different engine rather than inherited.

**KV → MySQL.** KV is used *only* by the OAuth library, for clients, grants, codes and
tokens. It holds no application data. Replace the library and KV disappears; grants
become ordinary rows, which is arguably better because **revocation becomes immediate
instead of eventually consistent**.

**Service Bindings → in-process calls.** This gets simpler. The two Workers exist
because Cloudflare Workers are separate deployment units; on one Node process
`validateToken` is a direct function call and the binding disappears.

**But the trust boundary goes with it.** ADR-003 chose two Workers so that a
cross-tenant bug in tool handling could not mint a token, and a bug in consent could
not read a page. One Node process means one runtime, one `NODE_OPTIONS`, one
filesystem, and no way to deploy the two roles separately. The boundary survives as
module structure, not as isolation. That is a real regression to record, not to
gloss.

**SQLite: not safely, for two independent reasons.** Premium's managed database is
MySQL; and Hostinger **replaces the application directory on every deploy**, keeping
only the two most recent builds, so a database file written beside the app is
destroyed on the next push. A path outside `hbuilds/` and `public_html` might
survive, but it is not documented as supported storage and betting customer
credentials on it is not defensible. `node:sqlite` being available in Node 22 does
not help with either point.

## 5. The security control that has no equivalent

Today the SSRF defence has four layers, and **layer one is the runtime**: the
`global_fetch_strictly_public` compatibility flag makes workerd refuse to connect to
private addresses. That is the layer that covers **DNS rebinding**, which no static
check can.

**No Node host provides an equivalent.** The remaining layers survive — URL policy,
redirect revalidation, response bounds — but they check the *hostname*, not the
*resolved address*. The compensating control on Node is a custom `lookup` on an
undici `Agent` that rejects a private address **after** DNS resolution. That is
implementable, and arguably stronger than the static check, but it is new
security-critical code that does not exist yet and would need its own tests.

`docs/SECURITY.md` currently describes layer one as the backstop. After any move off
Cloudflare, that sentence stops being true, and the document would have to say so.

## 6. Rebuilding the test suite

The 428 tests are the project's only evidence, and they run on `createTestHarness`
(miniflare) with a D1-backed schema worker. On Node:

- Most **test bodies** survive; the **harness** does not.
- `test/harness/schema-worker.ts` (D1), `mock-bludit.ts` (fine), the OAuth client
  helper (fine), and `startHarness` all need a Node equivalent.
- The live Bludit suite and the Playwright browser suite are the most portable,
  because they already talk HTTP to a real server.
- Anything asserting D1-specific SQL — the rate-limit counter, the PII-in-storage
  checks — needs rewriting for MySQL.

Until that is done, the port has **no automated proof that it preserves anything** —
including the two safety invariants (no delete tool, review-before-write) that the
current suite guards.

## 7. Hostinger-specific constraints for a Node port

Recorded for completeness, in case the plan ever changes to Business or Cloud.

| Constraint | Source | Impact |
|---|---|---|
| Node.js on Business/Cloud only | Hostinger | ❌ Premium excluded |
| Node 18/20/22/24; "Other" framework type with an entry file | Hostinger | ✅ Hono fits |
| Apps **stopped when idle**, restarted on next request | Hostinger | Cold starts; **no `setInterval`**, so cleanup must be cron |
| **`npm` cannot be run over SSH**; build commands come from a dropdown | Hostinger | TypeScript must be built by a supported command, or output committed |
| **App directory replaced on every deploy**, two versions kept | Hostinger | Rules out SQLite and any local state |
| Only outgoing WebSocket connections; inbound sockets need a VPS | Hostinger | Not a blocker — our transport is request/response JSON |
| Business: 150% CPU, 1–3 GB RAM, IOPS 1024, NPROC 50 | Hostinger | A single Node process fits; clustering would not |
| Outbound ports open except 0 and 25; cURL enabled | Hostinger | ✅ outbound HTTPS to Bludit sites works |
| Cron unlimited on Cloud | Hostinger | ✅ replaces the scheduled handler |

The one thing Hostinger would genuinely **improve**: there is no 10 ms CPU ceiling, so
PBKDF2 at 600,000 iterations — the entire reason Workers Paid is required — would run
without complaint.

## 8. Comparison for the Node port specifically

| | Cloudflare Workers Paid | Node on Hostinger Business/Cloud |
|---|---|---|
| Monthly cost | **$5.00** | $0 *incremental* — but Premium has no Node, so an upgrade is needed and costs roughly the same |
| Code change | **None** | Replace the OAuth server, the DB layer, the entrypoints and the test harness |
| Tests preserved | **428 of 428** | Harness rebuilt first; the suite is the last thing to come back |
| Security posture | Four SSRF layers, two-process boundary | Three SSRF layers until compensating code exists; one process |
| Reversibility | Rollback in one command | Rewrite back, or keep both |
| Performance | Global edge, no cold start for this workload | Single region, cold start after idle |

**The comparison that decides it is not $5 versus $0.** It is $5/month against
rewriting the credential-minting path and the suite that guards it, in exchange for
$60 a year.

## 9. Recommendation

Unchanged from the first version, and now better supported: **keep Cloudflare Workers
Paid at $5/month.**

On the evidence gathered across all of the `docs/hosting/` studies, the ranking is:

1. **Stay on Cloudflare Workers Paid — $5/month.** Zero code change, all 428 tests
   valid, the platform SSRF backstop intact, the two-process trust boundary intact,
   one-command rollback. This is the cheapest *safe* option that preserves everything.
2. **Do not deploy yet — $0.** Nothing requires a deployment until one real MCP client
   has been verified. The hermetic suite, the live Bludit containers and the browser
   suite all run free today. This is the true $0 option and it sacrifices only a public
   URL.
3. **PHP port on Premium — $0 incremental, high cost.** Per
   [the PHP study](hosting/PHP_ADAPTATION_ANALYSIS.md): feasible, but a second
   security-critical codebase, duplicating OAuth, sessions, crypto, tenancy, SSRF and
   the Bludit client, with no shared tests.
4. **Node port — not available on Premium.** Would require a plan upgrade that erases
   the saving. Quantified above for any future Node host.
5. **Rejected: Cloudflare Workers Free.** Two independent blockers, both already in
   `docs/ARCHITECTURE.md`: PBKDF2 at 600,000 iterations cannot fit a 10 ms CPU
   allowance, and Workers KV allows only **1,000 writes per day**, which one day of
   OAuth grants and refreshes would exhaust.

## 10. If a Node port is ever wanted anyway

Do not start with the rewrite. Do a spike that costs nothing and settles the unknowns:

1. On a Business/Cloud trial or an equivalent Node host, deploy a Hono app and confirm
   the runtime, the entry-file model, and **whether a TypeScript build runs**.
2. Have it fetch one external HTTPS URL — two minutes to settle outbound connectivity.
3. Connect MySQL and run the exact `INSERT … ON DUPLICATE KEY UPDATE` pattern the rate
   limiter needs.
4. Measure cold-start latency after ten minutes idle.
5. Only then scope the OAuth replacement, with its own decision-log entry and its own
   approval gate.

## 11. Note on this document's provenance

The first version of this report was written without knowing the plan was Premium, and
it listed a Node port as a live option. Corrected above.

Two further things the user should know, neither of them mine:

- **A concurrent session is working in this repository.** `docs/hosting/` contains six
  studies (A–E plus the PHP adaptation) written by another process during this same
  period. They are more complete than this document on the platform comparison and the
  PHP route, and this document now cross-references them rather than competing.
- **My commit `7b89401` accidentally included five of those files.** I ran `git add -A`
  for the security-gate commit and swept in `CLOUDFLARE_FREE_ANALYSIS.md`,
  `FREE_PLATFORM_COMPARISON.md`, `HOSTING_DECISION_MATRIX.md`, `HOSTINGER_ANALYSIS.md`
  and `ZERO_COST_FEASIBILITY.md` before they were finished. That is the same mistake as
  the earlier `bludit.png` incident, and it means those files carry my commit message
  rather than their author's. `PHP_ADAPTATION_ANALYSIS.md` and the latest edits to
  `HOSTINGER_ANALYSIS.md` remain uncommitted, as their author left them. **I have not
  touched any of them**, and I would not rewrite history to fix the attribution without
  explicit approval, because the other session is still writing.
