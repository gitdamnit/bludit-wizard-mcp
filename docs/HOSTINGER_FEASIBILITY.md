# Hostinger hosting feasibility

**Question.** Can Bludit Wizard MCP run on an existing Hostinger plan, avoiding the
Cloudflare Workers Paid subscription, without losing functionality?

**Verdict.** It can run, but not by moving the code. The business logic ports; the
**platform layer does not exist there and would have to be rebuilt**, including the
security-critical authorization server. The saving is $5/month. The cost is a
multi-week rewrite of the exact code path that keeps customer websites safe, plus
rebuilding the 428-test suite that is the project's only evidence.

**Recommendation: keep Cloudflare Workers Paid at $5/month.** The cheapest *safe*
option that preserves everything is the one already built. If $5/month must be
avoided, the honest alternatives are in §11 — and the truly lowest-cost option today
is to **not deploy at all**, because nothing requires a deployment until one real
client has been verified.

Research date: 2026-10-16. Sources are Hostinger's own documentation and support
articles; cited inline. **Nothing was deployed, migrated, or purchased. No source
code was changed by this investigation.**

> Note on the brief: it cites 411 passing tests. The current figure is **428**
> (395 hermetic, 24 against real Bludit, 9 in a browser). Two stale "411"
> references remain in `README.md`; they are a documentation slip from an earlier
> revision, not a change in results. Say the word and I will correct them.

## 1. Does Hostinger support the required runtime?

Yes, on the right plan, with caveats that matter.

| Requirement | Hostinger | Verdict |
|---|---|---|
| Node.js runtime | Business Web Hosting, Cloud Startup / Professional / Enterprise / Enterprise Plus. **Not** on Single or Premium | ✅ if the plan is Business or Cloud |
| Node versions | 18.x, 20.x, 22.x, 24.x | ✅ 22 is our development version |
| Custom framework | An **"Other"** type exists for apps without a detectable framework, where you supply an entry file and output directory | ✅ Hono fits |
| HTTPS endpoint | Web hosting serves inbound HTTPS with free SSL | ✅ |
| **Persistent process** | Server-side apps run a real process, with a **Restart** button in the dashboard | ⚠️ **but see below** |
| Outbound HTTPS | cURL enabled by default; ports 80 and 443 open; Hostinger documents Node apps connecting to **Supabase** and **MongoDB Atlas** | ✅ |
| Inbound long-lived connections | Web/Cloud allow only *outgoing* WebSocket connections; inbound sockets need a VPS | ✅ we need none |
| Cron | Supported; "unlimited" on Cloud plans | ✅ |
| Managed database | MySQL/MariaDB (150 databases on Business) | ⚠️ MySQL only, see §4 |
| Root access, Docker, PM2 | **Not available** on Web/Cloud. VPS only | ❌ |

Sources: [Node.js hosting options](https://www.hostinger.com/support/node-js-hosting-options-at-hostinger),
[How to add a Node.js web app](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger),
[Node.js overview](https://docs.hostinger.com/node.js/overview),
[Web standards and connectivity](https://www.hostinger.com/support/which-web-standards-and-connectivity-features-are-supported-at-hostinger),
[Parameters and limits](https://www.hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger/).

### Three caveats that change the design

**1. Applications run on demand and are stopped when idle.** Hostinger's own
documentation: "After a period without incoming traffic, your app's process is
stopped automatically to free up server resources. The next request … starts it
again."

Consequences: cold-start latency on the first MCP request; **no `setInterval`
scheduling** — the cleanup job must become a cron trigger; and no in-memory
state worth keeping (which we do not have, since the transport is stateless).

**2. You cannot run `npm` over SSH.** "npm commands are run automatically when you
deploy Node.js apps, but the command cannot be run through SSH… The npm build
commands available to you are visible in the Build settings dropdown."

Consequences: our project is TypeScript and needs a build. Either the build command
we need happens to be in that dropdown, or we commit compiled JavaScript. The
2-worker build (`build:auth`, `build:mcp`) has no equivalent — it becomes one app.

**3. The application directory is replaced on every deploy.** "Files under
`hbuilds/` and `public_html` are managed by the deployment system and are
overwritten on every deployment. Manual edits … won't persist." Only the latest two
successful versions are kept.

Consequence: **a SQLite file inside the application directory is destroyed by the
next deploy.** See §4.

### Resource limits

| Plan | CPU | RAM | IOPS | Processes (NPROC) | Databases |
|---|---|---|---|---|---|
| Business | 150% (≈2 cores on newer plans) | 1–3 GB | 1024 | 50 | up to 150 |
| Cloud Startup | 200% | 3 GB | 2048 | 100 | 300 |
| Cloud Professional+ | 300–800% | 4–10 GB | 2048–4096 | 100–200 | 300 |

Compared with Cloudflare Workers: **128 MB of memory and 10 ms–30 s of CPU per
invocation**, but no process cap and no IOPS ceiling of this kind. Our workload is
small — a few D1 rows per tool call — so Hostinger's limits are not the blocker.
The IOPS figure matters for §4.

**One genuine Hostinger advantage:** there is no 10 ms CPU ceiling, so PBKDF2 at
600,000 iterations — the reason Workers Paid is required — would run without
complaint. That is the one constraint Hostinger lifts.

## 2. Can the existing business logic be reused in Node.js?

**Largely yes.** The bulk of the code is plain TypeScript over Web APIs that Node
22 provides natively — `fetch`, `WebCrypto`, `Request`/`Response`/`Headers`,
`crypto.getRandomValues`. This is exactly the portability the project was written
for, and it is the strongest part of the news.

| Module | Portable? | Note |
|---|---|---|
| `src/bludit/*` (client, capabilities, types) | ✅ as-is | `fetch` + WebCrypto only |
| `src/proposals/diff.ts` | ✅ as-is | Pure functions |
| `src/shared/ssrf.ts` | ⚠️ mostly | Needs a DNS-aware compensating control (§5) |
| `src/shared/crypto.ts` | ✅ as-is | WebCrypto |
| `src/shared/scopes.ts`, `html.ts`, `cookies.ts`, `redirect.ts`, `errors.ts`, `log.ts` | ✅ as-is | Pure |
| `src/shared/pats.ts` | ⚠️ adapter | Uses the `D1Database` interface |
| `src/shared/rate-limit.ts` | ⚠️ adapter | D1 UPSERT with `RETURNING` has no MySQL equivalent (§3) |
| `src/mcp/tools/*` (all 19) | ✅ bodies | Tool logic unchanged; the DB handle changes type |
| `src/mcp/routing.ts`, `server.ts` | ✅ as-is | |
| `src/auth/accounts.ts`, `sessions.ts` | ⚠️ adapter | D1 → MySQL |
| `src/auth/app.ts`, `sites-ui.ts`, `tokens-ui.ts` (the whole UI) | ✅ Hono runs on Node | But they call the Cloudflare OAuth library |
| `src/auth/oauth.ts` | ❌ **must be replaced** | See §3 |
| `src/auth/index.ts`, `src/mcp/index.ts` (Worker entrypoints) | ❌ replaced | Two apps become one |
| `wrangler.*.jsonc` | ❌ replaced | Hostinger app configuration |
| `test/harness/*` (mock Bludit, schema worker, `createTestHarness`) | ❌ replaced | The 428-test suite is built on miniflare and D1 |

So: the domain logic is reusable, and the *platform integration* is not. That
distinction is the whole finding.

## 3. Replacing D1, KV, Service Bindings, and the OAuth provider library

**D1 → MySQL.** Mechanical for most of the schema: `TEXT`/`INTEGER` map directly,
`ON CONFLICT … DO UPDATE` becomes `INSERT … ON DUPLICATE KEY UPDATE`, and
`db.batch()` becomes a transaction. Two genuine snags:

- The rate limiter depends on `INSERT … ON CONFLICT … DO UPDATE … RETURNING count`
  to read the counter back in one statement. MySQL has no `RETURNING`. It becomes
  either two statements in a transaction or the `LAST_INSERT_ID(expr)` trick. Small
  work, but it is the one place where correctness depends on the SQL dialect.
- D1 is a single-writer SQLite database, which is what made the rate-limit counter
  atomic and globally consistent. MySQL with InnoDB is also fine here, but the
  reasoning recorded in ADR-011 would need restating for a different engine.

**KV → MySQL.** KV is used only by the OAuth provider library, for clients,
grants, authorization codes, refresh tokens and the token records themselves. It
holds no application data. If the provider library is replaced, KV disappears
entirely and grants become ordinary MySQL rows — which is arguably better, because
revocation would then be immediate instead of eventually consistent.

**Service Bindings → in-process calls.** This one gets *simpler*. The two Workers
exist because Cloudflare Workers are separate deployment units; the binding is how
the resource server asks the authorization server to validate a token. In a single
Node process, `validateToken` becomes a direct function call and the binding
disappears.

But it is not free: **the trust boundary goes with it.** ADR-003 chose two Workers
precisely so that a cross-tenant bug in tool handling could not mint a token, and a
bug in consent could not read a page. On shared hosting there is one process, one
`NODE_OPTIONS`, one filesystem, and no way to run the two roles as separately
deployed units. The boundary survives as module structure, not as isolation. That is
a real security regression and should be recorded as such, not glossed over.

**`@cloudflare/workers-oauth-provider` → ? This is the crux.** The library is
Cloudflare-specific: it takes a KV namespace, runs on the Workers runtime, and
advertises itself as a Workers OAuth provider. It cannot run on Node.

What it currently provides, all of which would have to be replaced:

- RFC 8414 authorization server metadata and RFC 9728 protected resource metadata
- Authorization Code with **PKCE `S256`**
- **Dynamic Client Registration** (RFC 7591) and a registration-policy callback
- **Client ID Metadata Documents**, including the `client_id_metadata_document_supported` advertisement that Claude, Codex and OpenCode look for
- Token issuance, **refresh with rotation and idle expiry**, and RFC 7009 revocation
- Grant storage, consent transactions, remembered-consent cookies
- RFC 8707 resource indicators, RFC 9207 `iss`, and audience binding

The realistic replacement is **`oidc-provider` (Panva)**, a mature, widely deployed
Node authorization server. It covers OAuth 2.1, PKCE, DCR, refresh rotation and
revocation, and it takes an adapter you supply — so grants land in MySQL. It does
**not** provide, and would need custom work:

- RFC 9728 protected-resource metadata and the `401` + `resource_metadata` challenge shape
- **CIMD** (not an OIDC feature) and its advertisement
- The MCP scope step-up behaviour, where a `403` names the complete required scope set
- MCP-shaped error responses at the token endpoint

That list is not large, but every item is security-critical protocol surface, and
each would need tests before it could be trusted. Hand-rolling the provider instead
is not advisable.

## 4. SQLite, or another supported database?

**SQLite: not safely.** Two independent reasons.

1. Hostinger's managed database is **MySQL**. There is no documented SQLite option
   on Web/Cloud hosting.
2. Even though Node 22 ships `node:sqlite`, **the application directory is replaced
   on every deploy**, and only the two most recent builds are retained. A SQLite
   file written beside the app would be destroyed on the next push — losing every
   account, site connection, encrypted credential and audit row. A path outside
   `hbuilds/` and `public_html` might survive, but Hostinger does not document one as
   supported storage, and betting customer credentials on an undocumented path is
   not a defensible design.

**MySQL: yes, and it fits the data well.** Every table is small and relational:
`users`, `sessions`, `sites`, `pairing_challenges`, `proposals`, `audit_log`,
`rate_limits`, `personal_access_tokens`. Credentials stay as AES-GCM ciphertext in a
`TEXT` column, exactly as today. Row counts are trivial for a shared plan.

**PostgreSQL via Supabase** is offered through Hostinger's Database Connect Wizard,
and Supabase has a free tier — but that is a **second external provider** with its
own account, its own free-tier limits, its own availability, and its own
sub-processor to disclose. It would not be a simplification.

One caution on MySQL here: shared plans publish an **IOPS ceiling (1024–4096)** and
a low I/O throughput (3–6 MB/s) shared across the account. Our write volume is
small, but a connection-per-request pattern without pooling would exhaust MySQL
connections quickly. A pool is mandatory, not optional.

## 5. Can OAuth 2.1, PKCE, revocation, PATs, isolation, the 19 tools and the controls be preserved?

| Must preserve | Preservable? | How |
|---|---|---|
| OAuth 2.1 + PKCE `S256` | ✅ | `oidc-provider` |
| Token refresh with rotation | ✅ | `oidc-provider` |
| Token revocation | ✅ **improved** | MySQL row instead of eventually-consistent KV |
| Dynamic Client Registration | ✅ | `oidc-provider` |
| Client ID Metadata Documents | ⚠️ custom | Not an OIDC feature; must be implemented and advertised by hand |
| RFC 9728 protected-resource metadata, `401` challenge | ⚠️ custom | Ours to implement |
| Scope step-up `403` challenge | ⚠️ custom | Our own code, ported |
| Personal access tokens | ✅ | Our own code, ported over a MySQL adapter |
| Multi-user site isolation | ✅ | Same `WHERE user_id` predicates |
| All 19 tools | ✅ | Unchanged |
| No-delete-by-agent, review-before-write | ✅ | Pure logic, unchanged |
| Credential encryption at rest | ✅ | WebCrypto; unchanged |
| Rate limiting | ⚠️ rewritten | New SQL for MySQL; same buckets |
| Audit logging | ✅ | Same rows |
| **Platform-level SSRF backstop** | ❌ **lost** | No `global_fetch_strictly_public` equivalent |
| **Process isolation between auth and resource roles** | ❌ **lost** | One process (§3) |

### The two regressions worth weighing

**SSRF loses its strongest layer.** Today the defence has four layers, and layer one
is the runtime refusing to connect to private addresses — the layer that covers DNS
rebinding, which no static check can. Hostinger offers no equivalent. The remaining
layers (URL policy, redirect revalidation, response bounds) survive, but they check
the *hostname*, not the *resolved address*. The compensating control on Node is a
custom `lookup` on an undici `Agent` that rejects a private address after DNS
resolution — implementable, and arguably stronger than the static check, but it is
new security-critical code that does not exist yet and would need its own tests.
`docs/SECURITY.md` currently describes layer one as the backstop; that would stop
being true.

**The two-Worker trust boundary collapses to module structure.** See §3.

Neither is a reason the port is impossible. Both are reasons it is not a
configuration change.

## 6. What changing to a Hostinger subdomain would require

1. **Confirm the plan.** Node.js needs **Business or Cloud**. On Premium or Single it
   is unavailable, and upgrading to get it costs roughly what Workers Paid costs — so
   the saving evaporates before any code is written. **Check this first.**
2. **Restructure two Workers into one Node app.** One Hono app mounting both route
   groups, served by `@hono/node-server` (or Express, which is on Hostinger's
   supported list). Remove `WorkerEntrypoint`, the Service Binding, and the Wrangler
   configs.
3. **Rewrite the data layer** behind an interface with a MySQL implementation.
4. **Replace the OAuth provider** with `oidc-provider` plus the MCP-specific work
   from §5.
5. **Replace the test harness.** The 428 tests run through `createTestHarness` and a
   D1-backed schema worker. Those would need a Node equivalent — most test bodies
   survive, the harness does not.
6. **Add a cron for cleanup**, since `setInterval` cannot be relied on and the
   process sleeps.
7. **Commit compiled output or find a supported build command**, because `npm`
   cannot be run manually.
8. **Deploy by ZIP or GitHub**, accepting that the app directory is replaced each
   time, and that no manual file edits persist.
9. **Point a subdomain at it**, and set the issuer and resource identifiers to that
   subdomain. Two roles in one app means **one origin**, which is simpler than the
   current two-hostname `workers.dev` arrangement.
10. **Add the DNS-aware SSRF control** to replace the lost platform layer.

## 7. Restrictions that could make this impractical

| Restriction | Impact | Blocking? |
|---|---|---|
| Node.js only on Business/Cloud | If the plan is Premium or Single, there is nothing to save | ⚠️ check first |
| No root, no Docker, no PM2 | No process manager, no custom runtime | Not blocking |
| No `npm` over SSH | Requires a supported build command or committed build output | ⚠️ unverified whether a custom build command is allowed |
| App directory replaced on deploy | Rules out SQLite and any local state | Not blocking (MySQL) |
| Process stopped when idle | Cold starts; no `setInterval` | Not blocking |
| IOPS 1024–4096, IO 3–6 MB/s | Shared ceiling; fine for our volume, needs pooling | Not blocking |
| NPROC 50 (Business) | A single Node process fits; clustering would not | Not blocking |
| Only one GitHub account per plan | Operational constraint | Not blocking |
| No `global_fetch_strictly_public` equivalent | SSRF layer one lost; needs compensating code | ⚠️ real, manageable |
| One process for both roles | Trust boundary becomes structural | ⚠️ real, accepted for a small deployment |

Nothing here is a hard blocker. The combination is what makes the port a project
rather than a migration.

## 8. Comparison

| Dimension | Cloudflare Workers Paid | Hostinger (Business/Cloud) |
|---|---|---|
| **Monthly cost** | **$5.00** | $0 additional **if** the plan is Business/Cloud; otherwise an upgrade costs about the same |
| **Engineering cost to switch** | **Zero.** Already built, tested, documented | Estimated tens of hours on the auth path alone, plus the test harness |
| **Complexity** | Two Workers, one D1, one KV, one binding — all already working | One Node app, one MySQL database, a replaced OAuth server, a replaced test harness |
| **Maintainability** | 428 tests, all hermetic except the live suite; CI typechecks, tests and builds both Workers | Tests must be rebuilt for the new runtime before they can guard anything again |
| **Performance** | Global edge, ~2–15 ms CPU per request, no cold start for our workload | Single region, cold start after idle, 3–6 MB/s IO shared with the account |
| **Security posture** | Four SSRF layers, two-process trust boundary, 10 ms CPU cap (the reason for $5) | Three SSRF layers unless compensating code is added, one process, no CPU cap |
| **Reversibility** | Change nothing | Rewrite back, or keep both and pay twice |
| **Risk to the 428 tests** | None | High — the harness they run on disappears |
| **Blast radius of a mistake** | A Worker deploy, rolled back in one command | A shared hosting account holding credentials for customer websites |

The last row is the one I would weigh most. The current design keeps customer
Bludit credentials in a system with a documented rollback and a 30-day
point-in-time recovery window on D1. Moving them to a shared hosting account does
not obviously improve that, and the migration itself is when they are most exposed.

## 9. What I could not verify

Stated plainly, because the recommendation depends on these:

1. **Whether a custom build command is allowed.** Hostinger says build commands come
   from a dropdown. If no TypeScript build is available, compiled output must be
   committed, which is workable but ugly.
2. **Whether outbound HTTPS to arbitrary third-party hosts is unrestricted in
   practice.** The "only outgoing WebSocket connections" sentence sits under an "Are
   sockets supported" heading and appears to describe raw TCP sockets, not HTTP. It
   is corroborated as harmless by cURL being enabled by default, ports 80/443 being
   open, and Hostinger's own Node-to-Supabase and Node-to-MongoDB-Atlas guides. I
   would still confirm it with a two-minute smoke test before committing to
   anything — deploy a Node app that fetches one external HTTPS URL and reads the
   response.
3. **Whether the on-demand process start introduces a latency that breaks an MCP
   client's timeouts.** Plausible but unmeasured.
4. **Whether there is any supported writable storage outside the app directory**, if
   SQLite were ever preferred. Not documented.
5. **The exact current plan and its renewal price.** Everything about cost turns on
   this, and only the user can see it.

## 10. Recommendation

**Keep Cloudflare Workers Paid at $5/month.**

Not because it is the cheapest line on a bill — because it is the cheapest *safe*
option. The comparison that matters is not $5 against $0; it is $5 against a
multi-week rewrite of the authorization server, the loss of two security layers, and
a rebuilt test suite — in exchange for **$60 a year**. The payback period, if the
work were valued at even a modest hourly rate, is measured in years.

Concretely:

1. **$5/month buys:** zero code change, all 428 tests still valid, the platform SSRF
   backstop, the two-process trust boundary, and instant rollback.
2. **Hostinger buys:** $60/year, and a platform rewrite whose hardest part is the
   credential-minting path.
3. **The thing that actually costs money is not the hosting.** It is the risk of
   shipping a rebuilt authorization server without the tests that currently make it
   trustworthy.

### If $5/month is genuinely unacceptable

Ranked, cheapest-and-safest first:

1. **Do not deploy yet — $0.** Nothing requires a deployment until one real MCP
   client has been verified end to end. Local development, the hermetic suite, the
   live Bludit containers and the browser suite all run free, today. This is the true
   lowest-cost option and it loses nothing except a public URL. *(Recommended if the
   goal is "spend nothing now".)*
2. **Keep Cloudflare at $5/month.** The recommendation above. *(Recommended if the
   goal is "ship safely and soon".)*
3. **Hostinger port, as a separately scoped project** — only if the plan is already
   Business or Cloud, and only with the spike in §12 passing first. Expect the OAuth
   replacement and the test-harness rebuild to be the bulk of the work, and accept
   the two documented security regressions.
4. **Rejected: Workers Free.** Two independent blockers, both already documented in
   `docs/ARCHITECTURE.md`. PBKDF2 at 600,000 iterations cannot fit a 10 ms CPU
   allowance, and Workers KV allows only **1,000 writes per day** on the free tier,
   which one day of OAuth grants and refreshes would exhaust. Dropping passwords for
   passkeys would fix the first and not the second.

## 11. If the Hostinger route is chosen anyway

Do not start with the rewrite. Start with a **one-day spike** that costs nothing and
answers the five unknowns:

1. On the actual plan, create a Node.js web app from a public GitHub repo.
2. Confirm the Node 22 runtime, the "Other" framework type, and **whether a
   TypeScript build command can be run**.
3. Have the app fetch one external HTTPS URL and return the status — this settles
   the outbound-connectivity question in two minutes.
4. Connect it to a Hostinger MySQL database and run one `INSERT`, one `SELECT` and
   the `INSERT … ON DUPLICATE KEY UPDATE` pattern the rate limiter needs.
5. Measure cold-start latency after ten minutes idle.

If all five pass, the port is worth scoping properly, with its own decision log
entry and its own approval gate. If any fails, the answer is Cloudflare at $5.

## 12. Bottom line

The code is portable. **The platform is not.** Roughly two thirds of this codebase
is plain TypeScript that would run on Node unchanged, and that is a credit to how it
was written. The remaining third — the authorization server, the storage bindings,
the request entrypoints and the test harness — is precisely the third that makes the
service safe, and none of it transfers.

$5/month is not the expensive part of this decision. Rewriting the authorization
server without the 428 tests that currently guard it is.
