# Study B — Existing Hostinger Hosting

**Question:** can the MCP service run on the existing Hostinger Business or Cloud plan at **no additional monthly
cost**?

**Verdict:** the runtime can host a *Node rewrite*; it **cannot** run the Cloudflare Workers implementation. Whether it
is **$0** depends entirely on **which plan is owned** — which could not be established from this environment and is
recorded as an **unresolved dependency**. Hostinger is therefore a viable **$0-after-port** option, not a
**$0-without-port** option.

Sources: Hostinger documentation, read 2026-10-16 (`docs.hostinger.com/node.js/overview`,
`.../creating-an-app`, `.../build-settings`, `.../environment-variables`, `.../file-structure`;
`hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger`,
`.../which-web-standards-and-connectivity-features-are-supported-at-hostinger`,
`.../1583765-how-many-cron-jobs-can-you-set-up-in-hostinger`, `.../how-to-deploy-a-nodejs-website-in-hostinger`).

## 0. Unresolved dependency — the plan

No authorized Hostinger account information was available in this environment: no API token, credential file, or CLI
was present (`env`, `~/.config/hostinger`, `~/.hostinger*`, `hostinger`/`hcloud` all absent). **The specific plan is
unresolved.** The consequence is binary:

- **If the plan is Business/"Unlimited" or any Cloud plan (Startup/Professional/Enterprise/Enterprise Plus):** Node.js
  Web Apps are **included** — up to **5** Node.js websites on Business/Unlimited and **10** on Cloud. The MCP service
  needs **one**. Marginal hosting cost ≈ **$0**, subject to having a free website/subdomain slot.
- **If the plan is Single or Premium:** Node.js is **not available** (Hostinger's changelog: Node.js on Business and
  higher). This option is then **not $0** — it needs an upgrade.

Confirm the plan before relying on this study.

## 1. Runtime support (facts)

| Requirement | Hostinger answer |
| --- | --- |
| Node.js runtime | Managed Node "Web Apps"; **Node 18/20/22/24**; **Hono is explicitly auto-detected/supported**; "Other" supported with manual settings |
| Entry file | Required for server frameworks; must end `.js`/`.mjs`/`.cjs`; must bind `process.env.PORT` |
| Long-running HTTP service | Long-lived Node process **while active**; **"runs on demand"** — the process is stopped after a period without traffic and restarted by the next request |
| Crash handling | "If your app crashes, Hostinger restarts it" |
| Public HTTPS | Free SSL per website; custom domain/subdomain |
| Environment secrets | Supported, encrypted, injected at **build and runtime**, ≤1,000 vars; keys `A–Z0–9_` only (all this app's vars already conform) |
| Databases | Managed **MySQL/MariaDB** included with the plan (per-plan count/size); the panel's "Database Connect Wizard" also links Supabase/MongoDB Atlas |
| Outbound network | All outbound ports open **except 0 and 25** (so HTTPS to customer Bludit sites works) |
| Incoming WebSocket | Not allowed on Web/Cloud (MCP is HTTP request/response — irrelevant) |
| Cron | Cron Jobs available (**unlimited on Premium+**); type **Custom** may run non-PHP commands |
| Resources | Unlimited: 2 CPU/3 GB RAM/50 GB disk; Cloud Startup: 4 CPU/4 GB/100 GB; more on higher tiers |
| Build limits | One deployment at a time (≤20 queued); dependency install and build script each ≤15 min |

## 2. Constraints that matter for this service

1. **The app directory is wiped on every deployment.** Deployed code lives under
   `~/domains/{domain}/hbuilds/versions/{build-id}/nodejs` (the live path is the `hbuilds/current` symlink). Hostinger
   documents: *"Files in `hbuilds/` and `public_html` are overwritten on every deployment,"* and only the live build is
   kept. **Never store a SQLite file inside the deployment.** Use MySQL (included) or a data directory **outside**
   `hbuilds/` (undocumented persistence guarantees).
2. **Scale-to-zero process model.** No guaranteed always-on daemon. In-process timers/`scheduled()` will not fire
   reliably while idle, and the first request after idle pays a cold start. Replace the two Cron Triggers with either a
   Hostinger "Custom" cron or an external pinger hitting a maintenance endpoint (see §5).
3. **No SSH `npm`** on Business/Cloud (builds run automatically). Fine for deploys; awkward for debugging.
4. **Native modules are a risk.** `better-sqlite3` would need a native build in Hostinger's managed build; prefer
   MySQL, or `node:sqlite` on Node 22/24.
5. **Custom cron running `node` is unverified** — must be confirmed with Hostinger support. Fallback: external cron →
   HTTPS endpoint.

## 3. What would replace each Cloudflare piece

| Cloudflare (current) | Hostinger replacement | Effort / risk |
| --- | --- | --- |
| Workers runtime + `cloudflare:workers` `WorkerEntrypoint` | One Node HTTP server (Hono runs on Node), entry file binding `process.env.PORT` | Moderate; portable |
| Two Workers + **Service Binding** (`AUTH_SERVER.validateToken`) | **Merge into one Node process**; `validateToken` becomes a direct function call (remove the split) | Low; removes the only cross-worker trust path |
| **D1** (`D1Database`, 41 call sites) | **MySQL** (included, supported) or SQLite via `node:sqlite` with a thin D1-shaped adapter | Moderate: port 3 migrations (`COLLATE NOCASE`, `ON CONFLICT`→`ON DUPLICATE KEY UPDATE`), keep the `.prepare().bind().first()/.run()/.all()` shape |
| **KV (`OAUTH_KV`)** | A SQL table behind a small `get/put/list/delete` wrapper | Low, but only needed because ↓ |
| **`@cloudflare/workers-oauth-provider`** | Node OAuth 2.1 library (`@node-oauth/oauth2-server` class) **plus custom DCR, CIMD, and RFC 8414/9728 metadata** | **High — the dominant cost and risk** |
| `scheduled()` Cron Triggers | Hostinger Custom cron or external pinger to a maintenance endpoint | Low–moderate |
| `global_fetch_strictly_public` (SSRF backstop) | Re-implement a DNS-resolving private-range check (undici `lookup`/agent); keep the existing static URL policy + redirect revalidation (`src/shared/ssrf.ts`) | Moderate and security-sensitive |
| `ctx.waitUntil` | Fire-and-forget | Trivial |

## 4. Can the existing code be preserved? (measured portability)

A local Node probe (temporary, removed after the study; see
[HOSTING_DECISION_MATRIX.md § Portability probe](./HOSTING_DECISION_MATRIX.md#portability-probe-measured)) establishes
what a Node port would reuse:

- **19/19 MCP tools register and enumerate under Node** with no Cloudflare globals — the entire `src/mcp/tools/**` and
  `src/bludit/**` layer is portable.
- **`@modelcontextprotocol/sdk` Streamable-HTTP transport loads in Node.**
- **Hono serves requests in Node.**
- **WebCrypto PBKDF2 works in Node** (600,000 iterations ≈ 400–500 ms — trivially affordable on a persistent process,
  unlike Workers Free).

Not portable: the OAuth provider library, `cloudflare:workers`, D1 types, KV, and the service binding. So
**~60–70 % of the codebase (tools, Bludit client, proposals, audit, sites, scopes, crypto, rate-limit SQL, static
SSRF policy) transfers**, while the **auth server is re-implemented** and **storage/bindings are re-plumbed**.

**Authentication contracts:** OAuth 2.1, PKCE, refresh rotation, revocation, DCR, CIMD, scopes and resource indicators
are governed by the MCP client ↔ this server protocol, so they are **preserved for clients**; only their server-side
implementation changes. PATs and tenancy are portable unchanged. The main assurance cost is that the current
workerd/Miniflare integration and OAuth-security tests are written against the Cloudflare library and must be
re-targeted at the Node server.

## 5. Deploying to a subdomain (what would change)

1. Add the subdomain as a **Node.js Web App** (a Node site must be added as a *new* website; an existing site on that
   hostname must be removed first).
2. Node **22/24**, build script (`npm run build`), entry file that binds `process.env.PORT`.
3. Set env vars: `SESSION_SECRET`, `CONSENT_SECRET`, `SITE_CREDENTIAL_KEY`, `CREDENTIAL_KEY_VERSION`, `AUTH_ISSUER`,
   `MCP_RESOURCE`, `ALLOW_SIGNUP`, `RATE_LIMIT_ENABLED`, `RL_*`, plus new `DB_*`. All existing names satisfy
   Hostinger's key rules.
4. Create a MySQL database; run the ported migrations; point the app at it.
5. Replace the two Cron Triggers with a Custom cron or an external scheduler that calls a maintenance endpoint.
6. OAuth redirects work normally over HTTPS on the subdomain; `AUTH_ISSUER`/`MCP_RESOURCE` become the subdomain URLs.
7. Verify the subdomain is free and that `hbuilds/` wiping does not touch whatever data directory is chosen.

## 6. Verdict

| Question | Answer |
| --- | --- |
| Can the current Workers code run here? | **No.** No workerd, no `cloudflare:workers`, no D1/KV/service bindings. |
| Can a Node port run here? | **Yes**, and the tools/Hono/MCP layers are measured to be portable. |
| At no additional cost? | **Only if the plan is Business/Unlimited or a Cloud plan** (Node.js included; ≤5/≤10 apps). Single/Premium would need an upgrade. **Plan unresolved.** |
| Reliability concerns | Scale-to-zero cold starts; deploy wipes the app dir (must use MySQL or external data dir); cron-running-node unverified. |
| Ops burden | High — you now own a database, migrations, TLS is managed, but patching/monitoring/backups are yours. |
| Preserves the 19 tools / auth / security? | Tools and isolation yes; authentication preserved for clients but **re-implemented server-side**. |

**Bottom line:** Hostinger is the best **$0-after-port** candidate *if and only if* the plan already includes Node.js
and a free subdomain slot. If the plan is Single/Premium, it is not a $0 option. This is the strongest reason to
**resolve the plan question first**.
