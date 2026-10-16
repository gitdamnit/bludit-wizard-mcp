# Zero-Cost Hosting Feasibility — Bludit Wizard MCP

**Study date:** 2026-10-15 / 2026-10-16
**Repository:** `Bludit-Wizard-MCP`, branch `feat/remote-mcp-oauth-v1`, commit `0cd0d6c`
**Method:** read-only source inspection + isolated local benchmarks (workerd/Miniflare and Node) + current vendor documentation.
**Nothing was deployed, no resources were created, no DNS was changed, no dependencies were added, and no production code was modified.**

Companion documents:

- [CLOUDFLARE_FREE_ANALYSIS.md](./CLOUDFLARE_FREE_ANALYSIS.md) — Study A, Cloudflare Workers Free
- [HOSTINGER_ANALYSIS.md](./HOSTINGER_ANALYSIS.md) — Study B, existing Hostinger plan
- [FREE_PLATFORM_COMPARISON.md](./FREE_PLATFORM_COMPARISON.md) — Study C, third-party free tiers
- [HOSTING_DECISION_MATRIX.md](./HOSTING_DECISION_MATRIX.md) — Study D/E, decision matrix, sacrifices, recommendation

---

## 1. The one question that decides everything

Can this service be hosted **for $0/month** while **preserving** its 19 tools, OAuth 2.1 + PKCE, personal access
tokens, multi-user/multi-site isolation, and its security controls?

**Answer: not with the current architecture.** Three independent facts, each verified, drive this:

1. **The auth layer is welded to the Cloudflare runtime.** `@cloudflare/workers-oauth-provider@1.2.3` imports
   `WorkerEntrypoint` from `cloudflare:workers` and stores every client, grant, authorization code, access token and
   refresh token in a KV namespace **hard-coded as `OAUTH_KV`** (47 references). It exposes no storage adapter. It
   cannot run outside workerd, and its grant storage cannot be moved to D1 without forking the library.
   *(Source: `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js` and its README.)*
2. **Password hashing does not fit the Workers Free CPU budget.** Measured in workerd on this machine:
   **PBKDF2-SHA256 at 600,000 iterations = 335 ms**, against a **10 ms/request** Free CPU limit. This is measured,
   not estimated ([CLOUDFLARE_FREE_ANALYSIS.md](./CLOUDFLARE_FREE_ANALYSIS.md#3-measured-benchmarks)).
3. **KV Free writes cap OAuth grant churn.** Free allows **1,000 writes/day to different keys**; every refresh
   rotation writes tokens. A single user with ~12 authorized clients refreshing hourly approaches the cap on its own.

Everything else the app needs **is** Free-compatible (D1 quota, service bindings, subrequests, cron, memory, bundle
size, and — measured — the entire 19-tool MCP layer runs under plain Node).

## 2. What was measured (not assumed)

| Probe | Where | Result |
| --- | --- | --- |
| PBKDF2-SHA256, 600,000 iterations | **workerd** (real runtime, via the repo's own harness) | **335 ms** (median of 2) |
| PBKDF2-SHA256, 25,000 / 100,000 iterations | workerd | 13 ms / 73 ms |
| PBKDF2-SHA256, 600,000 iterations | Node 22 WebCrypto | 361–516 ms |
| Full signup / signin request | workerd harness | 2.85 s / 1.4–1.9 s (dominated by harness overhead; see caveat) |
| All **19 tools register and enumerate** | **Node** (MCP SDK in-memory transport) | **19/19**, no Cloudflare globals |
| MCP Streamable-HTTP transport loads | Node | ✅ |
| Hono request handling | Node | ✅ HTTP 200 |

Caveat recorded honestly: the end-to-end request timings include large, noisy Miniflare dispatch overhead (a
`tools/list` call with no PBKDF2 measured 1,085 ms), so they are **not** CPU figures. The reliable CPU measurement is
the isolated PBKDF2 sweep, because PBKDF2 is pure CPU. Methodology and raw output:
[HOSTING_DECISION_MATRIX.md § Benchmark methodology](./HOSTING_DECISION_MATRIX.md#benchmark-methodology).

## 3. Verdict per study

| Study | Option | $0/month? | Preserves the current architecture? | Preserves all functionality? | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A** | Cloudflare Workers Free, unchanged | ✅ | ✅ | ❌ (password sign-in exceeds CPU; KV writes cap grants) | **NO-GO unchanged.** GO only with an upstream IdP and a single-user KV budget |
| **A′** | Workers Free + external IdP (GitHub/Google) | ✅ | ~ (auth users replaced) | ⚠️ (no self-hosted password accounts; ~1 user scale) | **Conditional GO** — smallest change that fits $0 |
| **B** | Existing Hostinger plan (Node) | ✅ *if plan includes Node.js* | ❌ (Node port required) | ✅ after a port | **Conditional** — plan membership **unresolved** |
| **C** | Third-party free tiers | Mixed | ❌ (Node/Deno port required everywhere) | ✅ after a port (Deno/Cloud Run worst fit for OAuth lib) | Oracle/Cloud Run/Deno only; others disqualified |
| **D** | Self-host on this Linux desktop + Cloudflare Tunnel | ✅ (no card, no sleep) | ❌ (port required; workerd not production-grade here) | ✅ after a port | **Best true-$0 always-on option** |
| **E** | Cloudflare Workers Paid | ❌ ($5/mo) | ✅ | ✅ | **Best low-maintenance fallback** |

**No $0 option runs the current Workers code unchanged.** The only unchanged option is Workers Free, and it fails on
CPU and KV.

## 4. Recommendation

- **OPTION A — best zero-cost:** **Cloudflare Workers Free with an upstream identity provider** (removes password
  hashing; keeps D1/KV/service bindings/the OAuth library/the 19 tools). Valid only for a **single user with roughly
  ≤10 authorized clients**, because of the KV write ceiling. If multi-user is required at $0, use
  **Cloudflare Tunnel + the existing Linux desktop** running a Node port instead (no card, no sleeping, no
  reclamation), or **Hostinger** if the plan already includes Node.js.
- **OPTION B — best low-maintenance:** **Cloudflare Workers Paid, $5/month.** Zero code changes, zero servers to
  patch, no cold starts, all 411 tests stay valid. This is the cheapest option **once maintenance time is priced in**.
- **OPTION C — best paid fallback:** Workers Paid as the primary paid path; a **$5–8/month VPS** (Hostinger VPS or
  equivalent) running the Node port is the alternative if leaving Cloudflare becomes necessary after a port.

**Direct answer:** reliable $0 hosting that preserves *all* current functionality is **not achievable** without
either (a) dropping self-hosted password accounts and accepting single-user KV limits (Workers Free + IdP), or
(b) porting the auth layer to Node and hosting it at $0 (desktop + Tunnel, or Hostinger if Node is included). See
[HOSTING_DECISION_MATRIX.md](./HOSTING_DECISION_MATRIX.md#sacrifices-required-by-each-option) for the exact sacrifices
of each option, and for the option that preserves the 19 tools, authentication, security controls and all viable
client integrations.

## 5. Scope of certainty

| Finding | Confidence |
| --- | --- |
| PBKDF2 600k exceeds 10 ms CPU in workerd | **Measured** |
| OAuth library requires `OAUTH_KV` and `cloudflare:workers`; no storage adapter | **Verified in source** |
| Free CPU/memory/subrequest/cron/D1/KV limits | **Official docs, Oct 2026** |
| D1 Free enforcement since 2026-09-01 | **Official changelog** |
| 19 tools register under Node | **Measured** |
| Hostinger plan membership | **Unresolved dependency** (no authorized account access) |
| End-to-end request latency on any candidate host | **Not measured** (no deployment permitted) |
| Multi-user KV/CPU headroom on Workers Free | **Estimated** from documented limits + token lifetimes |
