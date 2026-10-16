# Study D/E — Decision Matrix, Proof of Feasibility, Recommendation

## Benchmark methodology

All numbers in this study are either **measured** (this section), **documented** (cited vendor pages), or explicitly
labelled **estimated**. No deployment was performed.

**Environment.** Local machine, `git` commit `0cd0d6c`, Node 22, `wrangler` 4.151 (workerd/Miniflare via the
repository's own `test/harness`). Temporary benchmark files were created under `test/hosting-bench/` plus
`wrangler.bench.jsonc` and `vitest.hosting-bench.config.ts`, then **deleted**. No repository source, production
config, dependency, or Cloudflare/Hostinger resource was modified or created.

**What was measured and how.**

1. **PBKDF2 inside workerd.** A minimal temporary Worker ran `crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256'})`
   for iteration counts 1k…600k and returned `performance.now()` deltas; median recorded. Crypto is pure CPU, so this
   is a close proxy for billed CPU time.
2. **PBKDF2 in Node.** The app's own `src/shared/crypto.ts` (`hashPassword`/`verifyPassword`) executed under Node with
   600,000 iterations.
3. **Full OAuth/MCP request path in workerd.** The repository's harness (`startHarness`) with `PBKDF2_ITERATIONS=600000`
   drove signup, signin, discovery, DCR, authorize+consent+PKCE, token exchange, refresh, `tools/list`, `tools/call`
   (OAuth and PAT), and revocation, timing each.
4. **Portability probe under Node.** Imported the MCP SDK streamable-HTTP transport, Hono, and the app's tool registry;
   served a request; and enumerated tools through an in-memory MCP client.

**Caveat (recorded, not hidden).** The harness end-to-end timings include large, noisy Miniflare dispatch overhead —
a `tools/list` with no PBKDF2 measured 1,085 ms. They are **not** CPU measurements and are excluded from CPU
conclusions. Only the isolated PBKDF2 sweep and the Node crypto timings are used as CPU evidence.

**Reproduction.** The benchmark sources were temporary; the exact raw output is reproduced below so the numbers can be
re-checked by re-creating the harness. Re-running requires the repository's test harness and the hidden-throwaway
files; it does not touch production config.

### Raw PBKDF2 (workerd) and Node results

```
PBKDF2-SHA256 in workerd (median of 2–3):
  1,000 iters →     1 ms
 10,000 iters →     5 ms
 25,000 iters →    13 ms
 50,000 iters →    26 ms
100,000 iters →    73 ms
300,000 iters →   163 ms
600,000 iters →   335 ms      ← the app's configured default

Node 22 WebCrypto (src/shared/crypto.ts), 600,000 iters:
  hash   361–516 ms
  verify 424–440 ms
```

### Portability probe (measured)

```
19/19 tools enumerate under Node via the MCP SDK in-memory transport:
  apply_approved_edit, create_page, edit_page, get_content_summary, get_drafts,
  get_page, get_related_pages, get_scheduled_pages, get_site_capabilities,
  get_website_settings, list_categories, list_pages, list_sites, list_tags,
  preview_page_changes, propose_page_edit, search_pages, select_site,
  verify_page_update
MCP streamable-HTTP transport loads in Node:  yes
Hono serves a request in Node:               yes (HTTP 200)
```

**Significance:** the MCP/tool/Bludit layer is portable to a conventional Node server **without modification**; the
non-portable surface is precisely the OAuth provider library, `cloudflare:workers`, D1, KV and the Service Binding.

---

## Decision matrix

Columns follow the study brief. "Code changes" is engineering scope; "OAuth compat" means the *client-visible* OAuth
2.1 behaviour is preserved. Money is USD. Maintenance is valued transparently at **$50/hour** (adjust the rate; the
conclusion is insensitive to it because the one-time port is 3–4 orders of magnitude larger than a $60/year plan).

| Option | Monthly min cost | Overage charges | Ops complexity | Code changes | Security | Reliability | Persistent storage | Multi-user scale | OAuth compat | Est. deploy time | Maintenance/yr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Cloudflare Workers Paid** (baseline) | **$5** | usage-based, generous included limits | **None** (unchanged) | **0** | Unchanged (provider library + runtime SSRF) | Edge, no cold starts, SLA-backed | D1 + KV (managed, backed up via Time Travel) | ✅ | ✅ unchanged | ~0 (already built) | ~1–2 h |
| **Cloudflare Workers Free + IdP** (A, minimal) | **$0** | D1 daily hard-fail; KV 1k writes/day | Low (CF-managed) | Small (signin/signup → IdP) | **Not weakened** (no password store) | Good, no cold start; hard quota cliffs | D1 + KV (Free limits) | ❌ ~1 active user | ✅ unchanged for clients | 1–3 days | 2–4 h |
| **Hostinger Node port** (B, if plan includes Node) | **$0 marginal** *(plan-dependent)* | none (fixed plan) | High (own DB, deploy wipe, cron) | Large (OAuth AS re-implemented; D1→MySQL; KV→SQL; binding→in-process) | Preserved only if the new OAuth AS + SSRF DNS check are correct | Scale-to-zero cold starts; deploy wipes app dir | MySQL (included) | ✅ | ✅ (re-implemented server-side) | 2–4 weeks | 12–24 h |
| **Desktop + Cloudflare Tunnel** (C) | **$0** | none | Medium (own machine, patching, backups) | Large (same port) | Good if port correct; origin is a home machine | Good while the desktop is on; single point of failure | Local SQLite | ✅ (bounded by desktop) | ✅ (re-implemented server-side) | 2–4 weeks | 12–24 h |
| **Oracle Always Free VM** | **$0** | none (no card charges) | High (patch OS, TLS, backups) | Large (same port) | Good if port correct | **Idle-reclaim risk**; capacity at provisioning | 200 GB block storage | ✅ | ✅ (re-implemented server-side) | 2–4 weeks | 12–24 h |
| **Google Cloud Run** | **$0** | **billed**; no auto-cutoff unless set | Medium | Large (same port) | Good if port correct | Scale-to-zero ~1.2 s; needs external DB | None local (external DB) | ✅ | ✅ (re-implemented server-side) | 2–4 weeks | 12–24 h |
| **Deno Deploy** | **$0** | **none** (pauses) | Low–Medium | Very large (Deno port + KV API) | Good if port correct | No VM sleep; 10 CPU-h/mo cap | Deno KV / PG | ✅ | ✅ (re-implemented server-side) | 2–4 weeks | 12–24 h |

### Cost of ownership, not just subscription

| Option | Subscription | One-time engineering | 3-year total @ $50/h |
| --- | --- | --- | --- |
| Cloudflare Workers Paid | $60/yr | ~0 | **~$180 + ~6 h** |
| Workers Free + IdP | $0 | ~16 h | **~$800** (plus a hard multi-user ceiling) |
| Hostinger Node port | $0* | ~80–160 h | **~$4,000–$8,000*** |
| Desktop + Tunnel | $0 | ~80–160 h | **~$4,000–$8,000** |
| Oracle / Cloud Run / Deno | $0 | ~80–200 h | **~$4,000–$10,000** |

\* Hostinger is $0 **only if** the plan already includes Node.js. If not, add the plan upgrade.

**Break-even:** Workers Paid's $5/month is recovered by every ~6 minutes of avoided porting time. The port costs
thousands of dollars of effort to save $60/year. **The lowest total cost is Cloudflare Workers Paid** — unless the
objective is specifically "learn/write a portable Node version", which the study brief does not ask for.

---

## Sacrifices required by each option

| Capability the brief requires | Workers Paid | Workers Free + IdP | Hostinger / desktop / Oracle / Cloud Run / Deno |
| --- | --- | --- | --- |
| 19 MCP tools | ✅ | ✅ (measured portable to Node too) | ✅ (measured portable) |
| OAuth 2.1 + PKCE + refresh + revocation | ✅ | ✅ | ✅ (re-implemented; must be re-verified) |
| Personal access tokens | ✅ | ✅ | ✅ |
| Multi-user / multi-site isolation | ✅ | ⚠️ ~1 active user (KV) | ✅ |
| Self-hosted password accounts | ✅ | ❌ replaced by upstream IdP | ✅ |
| Runtime SSRF backstop (`global_fetch_strictly_public`) | ✅ | ✅ | ❌ must be re-implemented (DNS rebinding) |
| Abuse protection (rate limiting, fail-open on D1 error) | ✅ | ✅ but D1 daily hard-fail can disable it | ✅ |
| Always-on, no cold starts | ✅ | ✅ | ❌ scale-to-zero (Hostinger/Render/Koyeb) or self-managed |
| 411-test assurance | ✅ stays valid | ⚠️ password tests replaced by IdP tests | ❌ workerd/OAuth suites must be re-targeted |
| Operational burden | none | low | high (you run a server, DB, backups, TLS) |
| Recurring cost | **$5/mo** | $0 | $0 (+ card/reclaim/expiry risks) |

**Client compatibility:** all 12 client families are unaffected by *where* the server runs — they perform MCP discovery
and OAuth against this server's issuer. The one migration caveat: changing `AUTH_ISSUER`/`MCP_RESOURCE` **invalidates
existing grants and tokens**, so a host migration forces every client to re-authorize once.

---

## Options

### OPTION A — Best zero-cost

**Recommended A: Cloudflare Workers Free with an upstream identity provider**, constrained to a single active user.

- Keeps D1, KV, Service Bindings, the OAuth provider library, the 19 tools, PATs and tenancy.
- Removes PBKDF2 from the request path (the measured 335 ms blocker) by federating sign-in to GitHub/Google.
- **Caps:** ~1 active user / ≲10 authorized clients (KV 1,000 writes/day); Free request 100 k/day; D1 daily hard-fail.
- Security is **not** weakened — password storage is removed, not degraded.

**If multi-user $0 is required**, Option A moves to **Cloudflare Tunnel + the existing Linux desktop** (a true-$0
always-on host, no card, no sleeping) or **Hostinger if the plan includes Node.js** — both requiring the Node port.

### OPTION B — Best low-maintenance

**Cloudflare Workers Paid, $5/month.** Zero code changes, zero servers, no cold starts, all 411 tests remain valid, and
the OAuth provider and runtime SSRF backstop stay exactly as audited. This is the option that preserves **100 %** of
current functionality and security.

### OPTION C — Best paid fallback

**Workers Paid is the paid fallback** (cheapest path to "everything works"). If leaving Cloudflare ever becomes a
requirement, a **$5–8/month VPS** (Hostinger VPS or equivalent) running the Node port replaces it; that is a
post-port decision, not a prerequisite.

---

## Final recommendation

1. **Can the existing Cloudflare architecture be adapted to Free safely?**
   **No — not as-is.** The measured PBKDF2 cost (335 ms vs 10 ms) breaks sign-in, and the OAuth library's KV storage
   cannot be moved to D1 (verified in source). The *only* safe Free adaptation is to remove password hashing by
   federating sign-in, and even then Free is a single-user tier because of KV writes.

2. **Can Bludit Wizard MCP be reliably hosted for $0/month preserving all functionality?**
   **Not without a port.** Every $0 host requires replacing the OAuth provider library and storage; the only unchanged
   host (Workers Free) sacrifices password accounts and multi-user scale.

3. **Recommended architecture:**
   - If reliability and maintainability matter most → **Cloudflare Workers Paid ($5/mo)** (Option B). Lowest *total*
     cost, zero sacrifices.
   - If $0 is mandatory and single-user is acceptable → **Workers Free + upstream IdP** (Option A).
   - If $0 is mandatory and multi-user/full functionality is required → **the Node port**, hosted on
     **Hostinger (if the plan includes Node.js)** or **this desktop behind a Cloudflare Tunnel**; Oracle Always Free or
     Cloud Run only if a small always-on server or a container+external-DB arrangement is preferred (card required;
     Oracle has idle-reclaim risk, Cloud Run has overage risk).

4. **Sacrifices:** Option A loses self-hosted passwords and multi-user scale. Options B–E lose **nothing** in
   functionality except that B–E with a port cost weeks of engineering; A is the only $0 option that avoids the port.

5. **Preserves the 19 tools, authentication, security controls and all viable client integrations:**
   - **Workers Paid** preserves all of them exactly.
   - **Workers Free + IdP** preserves all of them except self-hosted password accounts, and limits scale.
   - **Hostinger / desktop / Oracle / Cloud Run / Deno** preserve them only if the re-implemented OAuth 2.1 server and
     the re-implemented SSRF DNS check are correct and re-verified against the existing client-journey and
     security-control test intent.

6. **Do not** lower PBKDF2 iterations, shorten token lifetimes, disable revocation, or weaken the SSRF policy to fit a
   free tier. None of the recommended paths requires it.

**Acceptance:** $0 is achievable, but not while keeping the current Cloudflare-specific authentication stack unchanged.
The decision is therefore: **$5/month for zero-risk continuity (recommended)**, or **a real port** for $0.
