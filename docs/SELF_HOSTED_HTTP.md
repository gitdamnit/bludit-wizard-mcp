# Self-hosted Streamable HTTP transport — implementation design

**Status: design only. Nothing in this document is implemented.** It exists so the
decision to build (or not build) the remote transport can be made against something
concrete. Per the migration plan, implementation awaits explicit approval.

The local stdio edition is delivered and is the primary distribution. This document
describes the *optional* transport for users who want their Bludit site reachable
from a hosted AI client.

---

## 1. The problem this solves, and the one it creates

**Solves.** Some clients cannot run a local process. A hosted client — claude.ai
web connectors, Gemini apps, Mistral's Connectors UI — can only reach a server at a
public URL over Streamable HTTP. Without this transport, those clients cannot use
Bludit Wizard MCP at all. That is a real gap, and it is the *only* reason to build
this.

**Creates.** A local stdio process has no network exposure, one user, and no
credentials at rest. A remote HTTP server has all three problems at once. Everything
below is the cost of that transition, and it is substantial:

| Property | Local stdio | Self-hosted HTTP |
|---|---|---|
| Network exposure | none | public URL |
| Principal | the process owner | a remote caller |
| Credentials at rest | none | site tokens in a database |
| Authorization needed | no | yes |
| SSRF input | the user's own URL | possibly a stranger's |
| Backup / rotation / recovery | none | all three |
| Cost | £0 | £0–5/month (a VPS) |

The maintainer's premise — no hosted service operated for others — is preserved: the
maintainer operates nothing. **The user operates their own server.** That is the
whole point, and it is also why this document has to be so careful: the person
carrying the operational risk is not the person who wrote the code.

### 1.1 Recommendation up front

Build it in the order given in §13, and **make the single-user topology the only
supported configuration in the first release**. Multi-user on one instance is
strictly more dangerous (tenancy isolation, credential blast radius, per-tenant SSRF)
and serves a much smaller group. A user who wants to serve several people can run
several containers; that is cheaper to reason about than one shared instance.

---

## 2. Deployment topologies

### 2.1 Topology A — single user, single site (recommended first)

One container, one site, one operator. Credentials in the container's environment or
a mounted secret file, exactly like the local edition. No database at all is
strictly required if proposals are held in memory and the site is fixed — which
makes this topology *the local edition plus a network listener*.

This is the honest design for "I want to use my Bludit site from Claude on the web".

### 2.2 Topology B — single user, multiple sites

Adds a small persistent store for the site list and their credentials. Proposals can
stay in memory.

### 2.3 Topology C — multiple users, multiple sites

Adds accounts, per-user site ownership, per-user credential encryption, and
per-tenant SSRF and rate-limit accounting. This is where the hosted Cloudflare
transport already lives; the honest comparison is that **the existing Cloudflare
adapter already solves this case**, and re-implementing it on a VPS would be a
second, less-tested implementation of the same tenancy code.

**Decision needed (D-0007 candidate):** whether Topology C is in scope at all, or
whether the answer to "I have several users" is "use the maintained Cloudflare
adapter".

---

## 3. Transport

Streamable HTTP (MCP 2025-06-18), which the server already implements for the
hosted transport in `src/mcp/app.ts` — the tool-facing part is done; what is missing
is a Node runtime, a store and an auth layer.

Requirements:

- `POST /mcp` with `Accept: application/json, text/event-stream`. Return JSON for
  short responses, SSE for streams.
- `Mcp-Session-Id` issued on `initialize`; reject unknown sessions with `404`. The
  hosted implementation is stateless per request (a fresh `McpServer` per call) and
  that property should be **preserved** — it removes the need for session affinity
  and for cross-request state.
- `GET /mcp` for server-initiated streams: return `405` unless implemented. The
  hosted transport does this; there is no server-initiated traffic to support.
- `DELETE /mcp` to terminate a session: `405` if stateless.
- `Origin` validation, and a `Content-Type` check, on every request. These are the
  DNS-rebinding and CSRF defences for a browser-reachable endpoint (§7.3).
- Body size limit and request timeout, enforced at the server *and* the proxy.
- **`401` with `WWW-Authenticate: Bearer resource_metadata="…"`** for unauthenticated
  requests (RFC 9728). Clients discover auth from this; without it, an
  OAuth-capable client has nothing to step up to.

Reuse: the MCP request handling, tool dispatch and `401` challenge logic from
`src/mcp/app.ts` are transport-independent and should be lifted, not rewritten.

---

## 4. Authentication

The task is explicit that this must not be hand-waved: *"Do not assume remote OAuth
can be replaced with a single static token for every target client."* That is
correct, and the client research in `CLIENT_COMPATIBILITY_MATRIX.md` shows why —
several clients support **only** static headers, and several support **only** OAuth.
There is no single mechanism that satisfies both.

### 4.1 The alternatives, evaluated

| Mechanism | Works for | Does not work for | Verdict |
|---|---|---|---|
| **Static bearer token** (like the existing PAT) | Copilot cloud agent, Gemini API agents, Mistral Vibe, Empryo, any header-capable client | Any client that *requires* OAuth discovery: claude.ai web connectors, GitHub Copilot's OAuth path, most consumer UIs | **Must exist.** Simple, and genuinely required by a subset of clients. |
| **OAuth 2.1 authorization server** (the existing implementation) | Codex, Cursor, VS Code, Claude, OpenCode, Gemini CLI, Mistral Le Chat… | Header-only clients | **Must exist** for the hosted-client case. Already written — with PKCE, DCR, CIMD, refresh and revocation. |
| **Reverse-proxy auth** (forward-auth, OIDC at the proxy) | An operator's own SSO | A client that has no way to present the resulting session — MCP clients will not drive an interactive browser login through a proxy | Not a primary mechanism. |
| **mTLS** | Machine-to-machine | Every desktop and web client in the matrix | No. |
| **Pre-registered OAuth client** (no DCR) | Operators who want a fixed client id; clients that support a fixed id | Clients that require DCR to onboard | **Worth supporting** as a fallback, as the hosted server already does. |

**Conclusion:** a self-hosted deployment needs **both** a static-token path and an
OAuth 2.1 path, and it must advertise both so a client can pick. Anything less
either excludes every hosted UI or excludes every header-only client.

### 4.2 What must not be simplified

- **No unauthenticated administrative tools.** Every `/mcp` request is authenticated
  before it reaches a tool. There is no anonymous mode, not even a read-only one —
  the read tools expose page content and site configuration.
- **No "one token for everyone".** A shared static token across users of one
  instance makes attribution and revocation impossible. If multi-user is supported,
  each principal gets their own credential.
- **The OAuth server must not simply be the Cloudflare one copied.** The hosted
  implementation stores grants in KV and Durable Objects. A Node port needs a
  different store and a different key-management story, and each of those is a
  chance to get token binding or expiry wrong.

### 4.3 Token storage

- Static tokens: store a **hash**, never the plaintext, exactly as
  `src/shared/pats.ts` already does. A leaked database must not be a leaked token.
- OAuth grants: store refresh tokens hashed; access tokens short-lived (the hosted
  default applies).
- All access tokens bound to the resource identifier (audience), and to a specific
  account.

---

## 5. Persistent storage

### 5.1 Is SQLite suitable?

**Yes, for Topologies A and B, and it is the right choice.** Reasons:

- Single-writer workload. MCP servers are low-QPS; SQLite's writer serialisation is
  not a bottleneck at this scale.
- One file, trivially backed up (`VACUUM INTO`, or `sqlite3 .backup`) — which
  matters enormously when the user, not the maintainer, is the operator. "Copy this
  file" is a recovery procedure a nontechnical user can execute.
- No second service to install, secure, or back up.
- WAL mode gives concurrent readers with a single writer, which is exactly the read
  pattern of tool calls plus occasional writes.
- Node bindings are mature: `node:sqlite` (Node 22.5+, still experimental) or
  `better-sqlite3` (native, needs a build toolchain in the image).

**Choose `node:sqlite` if the minimum Node is 22.5+; otherwise `better-sqlite3` with
a build stage in the Dockerfile.** Deciding this is a prerequisite, because it fixes
the minimum Node version for the whole edition.

**Not suitable for Topology C at scale** — multi-tenant with many concurrent writers
wants Postgres. But Topology C should arguably not be built at all (§1.1).

### 5.2 Schema

A minimal superset of what exists, using the same table shapes as the D1 migrations
so the application code is shared:

```
accounts(id, email, display_name, created_at)
sites(id, account_id, label, base_url, edition, capabilities_json,
      api_token_enc, auth_token_enc, wizard_api_key_enc, wizard_api_base,
      status, last_error, created_at, updated_at, last_checked_at)
pat_tokens(id, account_id, name, token_hash, scopes, created_at, expires_at, last_used_at, revoked_at)
audit_log(id, account_id, client_id, site_id, tool, outcome, detail, created_at)
proposals(id, account_id, site_id, page_key, base_revision, operation,
          payload_json, payload_hash, status, created_at, expires_at, applied_at)
oauth_grant(...)        -- only if the OAuth path is enabled
```

The `sites` table mirrors the D1 schema deliberately: `src/sites/registry.ts` and
`src/proposals/store.ts` then become bindings rather than rewrites, and the hosted
tests keep their meaning.

### 5.3 Credential storage and key management

This is the hardest part of the whole document, and the part most likely to be got
wrong.

- Site credentials are encrypted at rest, AES-256-GCM, with the site id as
  additional authenticated data — the existing scheme, unchanged.
- **The key must not live in the same place as the database.** Recommended: a
  mounted file read at startup (`SITE_CREDENTIAL_KEY_FILE`), `0600`, owned by the
  service user. Environment variables leak into `docker inspect`, `/proc/*/environ`,
  crash dumps and CI logs.
- **Key versioning must exist from the first release.** The hosted schema already
  has `credential_key_version`; a re-encryption path is much cheaper to build now
  than to retrofit. Record the version per row so rotation is possible without a
  flag day.
- **A lost key means lost credentials, not a security incident.** Say so in the
  docs. The user re-adds the site; nothing is exposed.

### 5.4 Secret rotation

| Secret | Mechanism | Frequency |
|---|---|---|
| Static PAT | Create new, revoke old. Both valid during overlap. | On suspicion; annually |
| Site API / auth token | Re-add the site; previous row superseded | On Bludit-side change |
| `SITE_CREDENTIAL_KEY` | Decrypt with old version, re-encrypt with new, bump `credential_key_version` | Annually, or on operator change |
| TLS certificate | Reverse proxy / ACME | automatic |

A rotation procedure that has never been executed is not a procedure. The Docker
image should ship an `npm run rotate-key` command, and the docs should tell the user
to back up first.

---

## 6. Single-user vs multi-user complexity

| Concern | Single-user | Multi-user |
|---|---|---|
| Site resolution | one site, from config | registry keyed by account |
| Credential scoping | one set | per account; blast radius on key compromise grows |
| Authorization | static token or OAuth, one principal | accounts, grants, per-user scopes, ownership checks on every site id |
| Tenancy isolation | not applicable | must be tested per endpoint; the hosted suite needs 12 cross-account probes and that effort would have to be repeated |
| SSRF input trust | the operator's own URL | potentially a stranger's URL |
| Audit trail | one user, useful for debugging | must be per-tenant and tamper-evident |
| Backup | one file | one file, but now contains many users' secrets |
| Support burden | "it's your server" | an operator can now host *other people's* credentials |

The last row is the real argument. Multi-user turns the operator into a data
controller for other people's CMS credentials. That is a legal and ethical position
a hobbyist deployer should not be nudged into by a config flag.

**Recommendation:** ship Topology A. Document Topology B. Refuse Topology C in code
(no schema, no endpoint) rather than in documentation.

---

## 7. Security for a network-exposed deployment

### 7.1 The controls that carry over unchanged

- **No delete tool.** Rests on the tool layer, which is unchanged.
- **Review-before-write**: `propose_page_edit` → `apply_approved_edit` with the
  revision pin and the `confirm: true` gate.
- **Credential redaction** in logs, errors and tool responses.
- **URL validation, bounded redirects, bounded response size and request timeouts**
  in the Bludit client.
- **Explicit failure states**: no silent partial success.

### 7.2 SSRF: what the platform gave us that a VPS does not

The hosted transport has four layers; `global_fetch_strictly_public` is the only one
that covers **DNS rebinding**, and it exists only on Cloudflare. On a VPS, layer
four is gone. The remaining three:

1. Static URL policy: scheme allow-list, reserved-range refusal (IPv4, IPv6,
   IPv4-mapped, NAT64, 6to4), credentials-in-URL refusal. `src/shared/ssrf.ts` — 422
   lines, already tested, and two real bypasses were found and fixed in it.
2. Redirect revalidation on every hop.
3. Response size and timeout bounds.

For a remote deployment the input is genuinely untrusted, so a fourth application
layer should be added and its limits stated:

- **Resolve, then validate, then connect to the resolved address.** A DNS lookup
  followed by a *fresh* connect is still two steps, so this **narrows** rebinding
  rather than eliminating it. Say exactly that; do not claim more.
- **Refuse to follow redirects to a different host** by default (opt-in).
- **Prefer an outbound network policy**: run the container on a network where it can
  reach the internet but not the LAN, and document it as the strongest available
  control. On a VPS this is often achievable with a firewall rule and is worth more
  than any application check.
- **Optional: require an explicit site-hostname allow-list** per site, so a tool can
  never be pointed at a host the operator did not enter. Cheap, and closes the
  rebinding window in practice.

The honest summary for the docs: *"We validate the URL, and we validate the
resolved address, but only an outbound firewall rule actually prevents access to
your internal network. Configure one."*

### 7.3 DNS rebinding and browser-origin attacks

A public MCP endpoint is reachable by a browser. The specific attacks:

- **A malicious page POSTing to the endpoint.** Mitigated by requiring
  `Content-Type: application/json`, rejecting simple CORS requests, and validating
  `Origin`. A browser cannot set a non-simple `Content-Type` without a preflight.
- **DNS rebinding** to reach the server through a trusted name. Mitigated by
  validating the `Host` header against a configured allowed host, and by requiring
  authentication. An unauthenticated endpoint is the precondition for the serious
  version of this.
- **No wildcard CORS.** `Access-Control-Allow-Origin` should be a configured list,
  and empty by default.

### 7.4 Rate limiting

The hosted transport rate-limits in D1. The VPS version needs an equivalent:

- Per-token and per-IP buckets on `/mcp`, on the auth endpoints and on the site-check
  endpoint (which makes outbound requests and is therefore an amplifier).
- Deliberately unbounded: revocation.
- Fail closed on the limiter store's own error, and log it — a limiter that silently
  stops limiting is worse than none.

---

## 8. HTTPS and reverse proxy

The container speaks HTTP on a private port; a reverse proxy terminates TLS. Do not
implement TLS in Node.

Required proxy behaviour, and it must be tested rather than assumed:

- Forward `Host`, and the app validates it (§7.3).
- Pass `X-Forwarded-For` **only** from a trusted proxy, and configure a trusted-proxy
  list — otherwise the per-IP rate limiter is trivially bypassed by a spoofed header.
- Do not buffer SSE responses (nginx: `proxy_buffering off`).
- Long read timeouts for streaming responses.
- Request body size limits, matching the app's.
- Security headers: HSTS, and no framing where the auth UI is served.

Recommended: Caddy (automatic ACME, small config) or nginx. Document the exact config
for both rather than leaving it to the reader — the difference between a working
deployment and a vulnerable one is usually in the proxy.

---

## 9. Docker Compose design

Sketch, not final:

```yaml
services:
  bludit-mcp:
    image: ghcr.io/<owner>/bludit-wizard-mcp:0.2.0   # pinned tag, never :latest
    restart: unless-stopped
    environment:
      MCP_PUBLIC_URL: https://mcp.example.com
      MCP_ALLOWED_HOSTS: mcp.example.com
      MCP_TRUSTED_PROXIES: 172.16.0.0/12
      SITE_CREDENTIAL_KEY_FILE: /run/secrets/credential_key
      STORE_PATH: /data/store.sqlite
    volumes:
      - ./data:/data
      - ./secrets/credential_key:/run/secrets/credential_key:ro
    ports:
      - "127.0.0.1:8787:8787"     # proxy only; never 0.0.0.0
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 30s
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data"]
volumes:
  caddy_data:
```

Points that matter:

- The app port binds to loopback; the proxy is the only thing on the network.
- `read_only: true` with a `/data` volume — the container writes only to its store.
- No `:latest`.
- Healthcheck distinguishes "process up" from "store reachable and serviceable".
- Secrets as files, not environment variables (§5.3).
- The image must run as a non-root user.

This Compose file must be tested in CI (`docker compose up`, run the MCP
initialization against it, tear down), or it will rot within one release.

---

## 10. Updates, backups, recovery

| Task | Procedure |
|---|---|
| **Update** | `docker compose pull && docker compose up -d`. Migrations run on start, forward-only. Pin tags; read release notes. |
| **Backup** | `sqlite3 store.sqlite ".backup /data/backup-$(date +%F).sqlite"` while running. Plus the credential key file, backed up **separately** — a backup containing both the database and the key is a plaintext credential archive. |
| **Restore** | Stop, replace the file, start. Document the version check: restoring a newer schema under older code must fail loudly, not half-work. |
| **Recovery from a lost key** | Re-add every site. State this in the docs so it is not a surprise. |
| **Rollback** | Keep the previous image tag. Migrations are forward-only, so a rollback may need a backup restore — say so instead of pretending otherwise. |
| **Logs** | stderr, JSON lines, secrets redacted. Ship nowhere by default; the operator decides. |

---

## 11. Installation on a user-controlled VPS

Target: a Bludit owner with a small VPS and basic shell competence, not a
Kubernetes operator.

1. Install Docker and Compose.
2. `git clone` the repository (or download the release's `compose.yaml`).
3. Generate the credential key: `openssl rand -base64 32 > secrets/credential_key`.
4. Create the first credential (a static token, or register an OAuth client).
5. Edit `Caddyfile` for the domain; `docker compose up -d`.
6. Add the site and its Bludit tokens — by editing config (Topology A) or through a
   small authenticated setup flow.
7. Add the URL to the MCP client.

Every step must be copy-pasteable, and the whole sequence should be executed
end-to-end on a clean VM before release. If step 6 requires a UI, that UI is a new
authenticated, CSRF-protected surface — a significant addition, not a detail.

---

## 12. Client capability projection

Derived from `CLIENT_COMPATIBILITY_MATRIX.md`, which records each client's
documented transports and auth. **No client product has been tested against this
server**, and that remains true for this projection — these are documented
capabilities, not verified behaviour.

Along the axis this migration cares about:

| Client surface | Local stdio | Remote HTTP | Auth to use remotely | Notes |
|---|---|---|---|---|
| OpenCode (V1/V2) | documented | documented | OAuth, or header | Both transports are documented |
| Claude Desktop | documented | via connectors | OAuth | stdio is the simplest path for a desktop user |
| Claude Code | documented | documented | OAuth | Both |
| Codex (CLI/IDE/desktop) | documented | documented | OAuth, CIMD, DCR | Both |
| Cursor | documented | documented | OAuth, DCR | Both |
| VS Code (Copilot agent) | documented | documented | OAuth, DCR | Both |
| Gemini CLI | documented | documented | OAuth, DCR | Both |
| Cline / Kilo Code | documented | documented | OAuth | Both |
| JetBrains Junie CLI / Air | documented | documented | OAuth | Both |
| **claude.ai web connectors** | **not possible** | documented | OAuth | A hosted web client cannot run a local process; stdio is not an option here |
| **Gemini apps (consumer)** | **not possible** | documented | DCR / manual | Same |
| **Mistral Le Chat** | **not possible** | documented | OAuth, DCR | Same |
| **Gemini Enterprise** | **not possible** | HTTP only | pre-registered + PKCE | SSE not supported |
| GitHub Copilot cloud agent / code review | **not possible** | documented | **static header only — no OAuth** | Needs the PAT path; code review additionally requires `readOnlyHint` |
| Mistral Vibe CLI | documented | documented | **static header only** | Needs the PAT path |
| Empryo | documented | documented | **static header only** | Needs the PAT path |
| JetBrains Junie IDE plugin | documented | unsupported | — | stdio only, documented as such |
| Mistral Code | — | — | — | No official MCP documentation |
| ChatGPT (consumer) | **not possible** | **not documented** | — | See `docs/OPENAI_PUBLICATION_CHECKLIST.md`; do not imply support |
| **ChatGPT Sites** | not investigated | not investigated | — | Flagged in the migration as a possible ChatGPT-specific adapter, explicitly out of scope for this phase |

Two things this table exists to prevent:

1. **Claiming local stdio solves every client.** It does not. Every hosted web
   surface needs this HTTP transport, and two desktop clients (Junie IDE, and the
   header-only group's OAuth-required cousins) need care.
2. **Claiming a static token is enough.** Three client families in the matrix
   document *static headers only*. Several others document *OAuth only*. §4 is the
   consequence.

`Gemini Enterprise`, `ChatGPT` and `ChatGPT Sites` need verification against vendor
documentation before any claim is made. They were not investigated in this phase.

---

## 13. Implementation plan, if approved

Phased so each step is independently useful and separately reviewable.

| Phase | Deliverable | Why this order |
|---|---|---|
| **0** | Decide §1.1 (Topologies A/B/C), §5.1 (SQLite driver → minimum Node), §4 (PAT + OAuth, both) | Each fixes something structural; getting one wrong is expensive later |
| **1** | Node HTTP host for the existing MCP handling, static-token auth, single site from config, **no database** | Topology A with the least new surface. Proves the request path and the `401` challenge |
| **2** | SQLite store, sites and audit tables, encrypted credentials, key file + versioning | The first thing that persists a secret; deserves its own review |
| **3** | OAuth 2.1 on Node, reusing the existing protocol logic with a new store; DCR / CIMD / pre-registered | Only now, because it depends on the store |
| **4** | Hardening: DNS-aware guard, Host/Origin validation, trusted proxies, rate limits, container hardening | After the surface exists |
| **5** | Docker Compose + Caddy + a CI test that boots the stack and runs `initialize` | Packaging is not done until it is tested |
| **6** | Deployment guide, backup/rotate/recover runbooks, executed once on a clean VM | A runbook nobody ran is fiction |

Explicitly **not** in this plan: Topology C, ChatGPT Sites, any hosted service
operated by the maintainer.

---

## 14. Open questions

1. **Which topologies are in scope?** Recommendation: A, and B documented.
2. **Minimum Node version**, and therefore `node:sqlite` vs `better-sqlite3`.
3. **Does the OAuth path ship in the first release**, or is a static token enough
   for an initial audience that is mostly header-capable clients? Argument for
   shipping both: the hosted-UI clients are the main reason this transport exists
   at all, and they need OAuth.
4. **Is an authenticated setup UI required**, or is config-file editing acceptable
   for the target user? The former is a real security surface and should not be
   added casually.
5. **How is the container image distributed** — GHCR from this repository? Under
   whose account? That is an operational commitment, and it should be made
   deliberately.
