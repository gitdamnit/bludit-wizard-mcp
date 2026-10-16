# Study A — Cloudflare Workers Free

**Question:** can the existing two-Worker deployment run on **Workers Free** ($0) without weakening password hashing,
token security, isolation, or abuse protections?

**Verdict: NO-GO as-is. Conditional GO only after replacing password sign-in with an upstream identity provider, and
only at single-user scale.** The reasons are measured and verified below.

Sources: Cloudflare Workers/D1/KV limits and the D1 changelog, read 2026-10-15/16 (links inline). Local benchmarks run
against the repository's own workerd harness at commit `0cd0d6c`.

---

## 1. Workers Free limits that apply

Source: <https://developers.cloudflare.com/workers/platform/limits/> (last updated 2026-10-12).

| Feature | Workers Free | Workers Paid | This app's need |
| --- | --- | --- | --- |
| Requests | 100,000/day | no limit | fine |
| **CPU time per request** | **10 ms** | 5 min (default 30 s) | **PBKDF2 needs ~335 ms** |
| Memory per isolate | 128 MB | 128 MB | fine (Zod 4.6 is used, ≥4.5 for memory) |
| Subrequests/request | 50 | 10,000 | tight but designed for (see §5) |
| Simultaneous open connections | 6 | 6 | fine |
| Env vars/Worker | 64 | 128 | the app uses ~15 |
| Worker size (uncompressed) | 64 MiB | 64 MiB | fine |
| Cron Triggers/account | 5 | 250 | the app needs 2 |
| Workers/account | 100 | 500 | the app needs 2 |

The two auth Workers and the Service Binding between them are **all available on Free** (Service Bindings are not
plan-gated and are zero-cost; <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>,
read 2026-10-15). Each Service-Binding call counts toward the caller's 50-subrequest budget.

### Storage limits

| Feature | Free | Source |
| --- | --- | --- |
| D1 rows read | 5,000,000/day | <https://developers.cloudflare.com/d1/platform/pricing/> |
| D1 rows written | 100,000/day | same |
| D1 storage | 5 GB total, 500 MB/database, 10 databases | <https://developers.cloudflare.com/d1/platform/limits/> |
| D1 queries per Worker invocation | 50 | same |
| KV reads | 100,000/day | <https://developers.cloudflare.com/kv/platform/limits/> |
| KV writes to different keys | **1,000/day** | same |
| KV writes to same key | 1/sec | same |
| KV operations per invocation | 1,000 | same |
| KV storage | 1 GB | same |

### D1 Free enforcement (September 2026)

Effective **2026-09-01**, D1 on Workers Free **fails queries** when the account exceeds the daily row read or row write
limit, returning errors until 00:00 UTC, with email alerts
(<https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/>). This is now a hard
failure mode, not a soft warning. The service's rate limiter **fails open** on storage errors
(`src/shared/rate-limit.ts`), so a D1 exhaustion degrades abuse protection rather than blocking MCP traffic — but audit
rows and every D1-backed read (sessions, sites, proposals) would also error.

---

## 2. Why PBKDF2 exceeds the Free CPU limit (the decisive blocker)

The app hashes passwords with PBKDF2-SHA256 and a default of **600,000 iterations**
(`src/shared/env.ts`: `DEFAULT_PBKDF2_ITERATIONS = 600_000`; `src/shared/crypto.ts`: `derive()`).
`crypto.subtle.deriveBits` is pure CPU — Cloudflare's docs are explicit that only network/D1/KV waits are excluded
from CPU time; crypto is not.

Cloudflare's own guidance: "Heavier workloads that handle authentication … typically use 10–20 ms" — i.e. a generic
authentication Worker already strains the 10 ms Free budget. A 600,000-iteration PBKDF2 is 30× beyond even that.

There is a **documented but unquantified** escape hatch: "Each isolate has some built-in flexibility to allow for
cases where your Worker infrequently runs over the configured limit." Password authentication may not be built on an
undocumented, unquantified allowance — one retry storm, one cluster of sign-ins, or a moved isolate turns sign-in into
Error 1102. **We do not treat this as usable capacity.**

---

## 3. Measured benchmarks

Environment: local workerd via `wrangler`'s `createTestHarness` (the repository's own `test/harness`), production
PBKDF2 iterations, and a temporary benchmark Worker (since removed). Machine: the study host. Crypto is pure CPU, so
wall-clock here is a close proxy for billed CPU.

### PBKDF2-SHA256 inside workerd (median of 2–3)

| Iterations | Measured ms | Fits 10 ms/request? |
| --- | --- | --- |
| 1,000 | 1 | ✅ |
| 10,000 | 5 | ✅ |
| 25,000 | 13 | ❌ |
| 50,000 | 26 | ❌ |
| 100,000 | 73 | ❌ |
| 300,000 | 163 | ❌ |
| **600,000 (this app)** | **335** | ❌ **33.5× over budget** |

Interpolating, the Free 10 ms budget buys roughly **~18,000 iterations** — about **3 %** of the 600,000 this app uses,
and far below current OWASP guidance. **Reaching Free by lowering the iteration count would weaken password hashing**,
which the study forbids.

Node 22 WebCrypto on the same host measured 361–516 ms for the same work, so the cost is algorithmic, not a workerd
quirk.

### End-to-end request timings (informational only)

With 600,000 iterations the harness measured signup 2,850 ms, signin 1,383 / 1,891 ms. These are **not CPU figures**:
a `tools/list` call that performs no PBKDF2 measured 1,085 ms, and `discovery` measured 1,569 ms — Miniflare dispatch
overhead dominates. They are recorded for completeness and are explicitly excluded from the CPU conclusions.

### Non-crypto OAuth/MCP steps

PKCE verification (`SHA-256` of a short verifier), token issuance, refresh rotation, revocation, PAT verification
(`SHA-256` of a 192-bit token), and D1 rate-limit/audit writes are all small single-pass crypto/SQL operations. They
are **estimated** (not individually measured) at well under 10 ms of CPU. The measured evidence for that class is that
`tools/list` and `tools/call` completed with no CPU error under the harness and that the entire PBKDF2 sweep ran
without isolate issues. This estimate is flagged as an estimate.

---

## 4. Moving OAuth grant state from KV to D1 — verified contract

The task asks this explicitly and warns not to assume the library can be reconfigured. **It cannot.**

- `@cloudflare/workers-oauth-provider@1.2.3` declares exactly one storage location: a KV namespace **bound as
  `OAUTH_KV`**. README: *"The authorization server needs a KV namespace bound as `OAUTH_KV`…"*. Its compiled output
  references `OAUTH_KV` 47 times (`get`/`put`/`list`/`delete`), imports `WorkerEntrypoint` from `cloudflare:workers`,
  and exposes **no storage-adapter option** in `OAuthProviderOptions`/`OAuthAuthorizationServer` (routes, TTLs, CIMD,
  DCR, callbacks — no storage hook).
- The KV layout stores **access tokens, refresh tokens, authorization codes and client secrets as hashes**, with grant
  `userId`/`metadata` storage-visible for enumeration and revocation. `completeAuthorization()` **revokes earlier
  grants** for the same client+resource, using a `list()` over the user's grants and then writes.
- KV TTLs expire records; `purgeExpiredData()` sweeps the rest from a Cron Trigger.

**Consequences**

| Property | Assessment if forced onto D1 |
| --- | --- |
| Supported by the library | ❌ — requires forking the provider library |
| Transactional guarantees | D1 is single-writer SQLite; a bespoke D1 store *could* be transactional, but doing so is a rewrite of the auth store, not a config change |
| Performance | Possibly better than KV, but irrelevant while the library owns storage |
| TTL cleanup | Would move from KV-native TTL to application/cron deletes — new code and new failure modes |
| Token hashing / security | Would have to be preserved exactly; any reimplementation risks weakening token security |

**Therefore "move grants to D1 to fit Free" is not an adaptation — it is a fork of the security-critical auth store.**
Recorded as a rejected path.

---

## 5. KV write budget (the second blocker)

Free allows **1,000 writes/day to different keys**. From the library's documented behavior:

| Event | Approx KV writes |
| --- | --- |
| Authorization (consent → code) | 2–3 (consent transaction + code) |
| Token exchange | 3–4 (grant + access token + refresh token, code delete) |
| Refresh rotation (access token TTL is 3600 s) | 2–3 (new access + rotated refresh) |
| Revocation | 1–2 |
| `private_key_jwt` replay markers (CIMD clients) | +1 per assertion |

A client that stays connected all day refreshes ~24×/day → **~50–70 writes/client/day**. One user with the ~12 target
client families connected steady-state lands at **~600–850 writes/day before any authorizations** — at or over the
1,000/day ceiling. A second active user exceeds it.

**Estimated Free KV capacity: roughly one active user, ≲10–12 authorized clients, modest traffic.** Not multi-user.

> Note: the exact per-operation write count depends on the library's `storage-schema.md`, which is not included in the
> published package (`files: [dist, docs, skills]`; `docs/` does not ship it). The table above is derived from the
> library README + `docs/authorization-server.md` and is labelled **estimated**, not measured. The conclusion (Free KV
> is too small for multi-user OAuth token churn) is robust to a factor-of-two error because the ceiling is only 1,000.

---

## 6. Subrequests and D1 queries per request

- **Subrequests (Free: 50/invocation).** Each Service-Binding call counts, as do KV ops and `fetch()`es. The app
  already caps content scans at **`MAX_CONTENT_SCAN = 40` pages** specifically because "each page is a separate
  upstream request" and Free allows 50 (`docs/ARCHITECTURE.md`, `src/mcp/tools/intelligence.ts`). So a content-scanning
  tool can approach the ceiling but is designed to stay under it. This accommodation already exists.
- **D1 queries/invocation (Free: 50).** Per MCP request the code issues ~2 rate-limit UPSERTs (`mcp`, `mcp_account`),
  one audit `INSERT`, one site lookup and (for write tools) 1–2 proposal statements — well under 50.
- **D1 rows/day.** ~3 rows written and ~5 rows read per MCP request (estimated) ⇒ the **100,000 rows written/day**
  budget supports on the order of **~30,000 MCP requests/day**, and the 5 M rows read/day budget far more. The binding
  Free limit for MCP traffic is therefore the **100,000 requests/day**, not D1.

---

## 7. The one compliant adaptation: federate identity

If Free is required and the Cloudflare architecture is to be kept, the only path that does **not** weaken security is to
**remove password hashing from the request path** by federating sign-in to an upstream identity provider
(GitHub/Google OAuth — free). The provider library supports upstream sign-in (`docs/upstream-sign-in.md`, `EMA`
options). The app keeps: OAuth 2.1 + PKCE, DCR, CIMD, scopes, resource indicators, refresh/revocation, PATs, the 19
tools, tenancy, audit, rate limiting — and loses **self-hosted password accounts** (a functional change, not a
weakening: there is no password store left to weaken).

But this does **not** remove the KV ceiling. Grant/token churn is unchanged, so the deployment remains single-user-scale
on Free.

| Requirement | Workers Free + IdP |
| --- | --- |
| OAuth 2.1 + PKCE, refresh, revocation | ✅ unchanged |
| Personal access tokens | ✅ unchanged (D1) |
| 19 tools, isolation, audit, rate limiting | ✅ unchanged |
| Self-hosted password accounts | ❌ removed (federated instead) |
| Multi-user scale | ❌ capped by KV writes (~1 active user) |
| Code changes | Replace signin/signup with an upstream IdP flow; keep everything else |
| Tests | Password unit/integration tests would be replaced by IdP-flow tests |

---

## 8. Concrete Free-tier results

**Free-tier viability:** ❌ for the app as written. ⚠️ conditional for the IdP variant at single-user scale.

**Required modifications (IdP variant):** replace password signup/signin with an upstream IdP; keep D1, KV, service
bindings, provider library, tools. No storage rework (rejected above).

**Measured CPU consumption:** PBKDF2-SHA256 600,000 iterations = **335 ms** in workerd (≈10 ms budget ⇒ ~18,000
iterations fit). All other steps ≤ a few ms (estimated).

**Storage/write requirements (per active user):** D1 ~3 rows written and ~5 rows read per MCP request; KV ~50–70
writes/client/day plus ~6–8 per authorization.

**Expected capacity:** ~100,000 requests/day (request cap); ~30,000 MCP requests/day (D1 writes); **~1 active user /
≲10 clients** (KV writes).

**Risks:** Error 1102 on any password operation (measured); 1,000-write/day KV exhaustion mid-day (grant issuance
fails); D1 daily-limit hard failures since 2026-09-01; total loss of sign-in if the upstream IdP is unavailable.

**Compatibility consequences:** the 12 client families are unaffected (they speak OAuth to this server, not to the
IdP). Only the human sign-in step changes.

---

## 9. Cross-references

- Portability evidence (19 tools + Hono + MCP transport under Node): [HOSTING_DECISION_MATRIX.md § Portability probe](./HOSTING_DECISION_MATRIX.md#portability-probe-measured).
- The alternative $0 homes: [HOSTINGER_ANALYSIS.md](./HOSTINGER_ANALYSIS.md), [FREE_PLATFORM_COMPARISON.md](./FREE_PLATFORM_COMPARISON.md).
