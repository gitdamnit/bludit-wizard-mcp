# Architecture

> **Scope note.** This document describes the **Cloudflare Workers transport**,
> which is now one of three. The primary distribution is the local stdio edition
> ([LOCAL_STDIO.md](./LOCAL_STDIO.md)); the self-hosted HTTP transport is designed
> but not built ([SELF_HOSTED_HTTP.md](./SELF_HOSTED_HTTP.md)). All three share a
> portable core — the Bludit client, the 19 tools, the validation and the safety
> rules — extracted behind three ports (`SiteSource`, `AuditSink`,
> `ProposalStore`). The extraction and its measured dependency map are recorded in
> [REUSE_AUDIT.md](./REUSE_AUDIT.md). Everything below remains accurate for the
> Cloudflare transport, which is preserved and unchanged in behaviour.

## Topology

Two Workers, one shared D1 database, one KV namespace owned by the OAuth
provider, and a private Service Binding between them.

```
                     ┌──────────────────────────────────────────────┐
   MCP client ──────▶│  bludit-wizard-mcp  (resource server)        │
   (ChatGPT, Claude, │                                              │
    Codex, Gemini,   │  OAuthResourceServer                         │
    OpenCode, …)     │   • RFC 9728 protected-resource metadata     │
                     │   • 401 challenge / 403 scope step-up        │
        │            │   • stateless Streamable HTTP transport      │
        │            │   • 19 tools                                 │
        │            └───────────────┬──────────────┬───────────────┘
        │                            │              │
        │                Service Binding         D1 │ sites, proposals,
        │              (validateToken RPC)          │ audit, users, sessions
        │                            ▼              │
        │            ┌───────────────────────────┐  │
        │            │  bludit-wizard-auth       │  │
        │            │  (authorization server)   │──┘
        │            │   • discovery, token,     │
        └───────────▶│     revocation, DCR       │──── KV │ clients, grants,
         browser      │   • /authorize + consent  │        │ codes, tokens
         (consent)    │   • accounts, sessions    │
                      │   • site management UI    │─────────▶ Bludit site
                      └───────────────────────────┘   (pairing proof only)
                                                                 │
                      ┌───────────────────────────┐              │
                      │  Bludit site              │◀─────────────┘
                      │  /api/*  (official API)   │   resource server
                      │  /api/wizard/*  (optional)│   fetches pages here
                      └───────────────────────────┘
```

The browser only ever talks to the authorization server. The MCP resource server
is reached by MCP clients, and by nothing else.

## Why two Workers

The assignment asked whether separate Workers for the authorization server and
the resource server improve security and maintainability. They do, and this is
also the shape the official OAuth provider library recommends for new
deployments — its own reference example is a two-Worker split.

**Security.** The two roles have genuinely different exposure and credentials:

| | Authorization server | Resource server |
|---|---|---|
| Who reaches it | A human's browser | MCP clients, with a bearer token |
| Holds | OAuth KV namespace, `CONSENT_SECRET`, `SESSION_SECRET`, password hashes | Bludit site credentials, `SITE_CREDENTIAL_KEY` |
| Can mint tokens | Yes | No — it only asks about them |
| Can read page content | No | Yes (fetches from the CMS) |

A cross-tenant bug in the resource server's tool handling cannot mint a token,
and a bug in the consent flow cannot read a page. The token validator is the only
cross-Worker call, it is one method wide (`validateToken(resource, token)`), and
it is a private binding rather than a public HTTP endpoint — the resource server
does not need, and does not have, network reachability to the authorization
server's origin.

**Maintainability.** Each Worker has one job, one entry module and its own
routes. The split is also the natural place to enforce the identity boundary: the
resource server never imports account, session or consent code, and the
authorization server never imports the CMS client for content reads.

**Cost.** Service Bindings do not incur extra request fees on the Workers
Standard model: a call is billed as one request plus the CPU time of both
Workers. So the split is free at the billing level.

**What was given up.** Two deployments to keep in step, and a shared D1 database
that both Workers bind. The shared database is a real coupling — a schema change
must be compatible with both, which is why every column the resource server reads
already existed when it was written. `migrations/` is owned by the authorization
server's config, which is the one that runs `wrangler d1 migrations apply`.

A single-Worker variant remains available in the OAuth provider library
(`OAuthProvider`, the 0.x shape) and would be simpler to deploy, but it puts
token issuance and content access in one trust boundary. Not worth it here.

## Bindings

### `bludit-wizard-auth`

| Binding | Type | Purpose |
|---|---|---|
| `OAUTH_KV` | KV namespace | Clients, grants, authorization codes, refresh tokens, pending consent transactions. Written and read only by the OAuth library. |
| `DB` | D1 | `users`, `sessions`, `sites`, `pairing_challenges`, `proposals`, `audit_log` |
| `AUTH_ISSUER` | var | Public issuer, e.g. `https://mcp.evanzellner.com` |
| `MCP_RESOURCE` | var | Canonical MCP resource, e.g. `https://mcp.evanzellner.com/mcp` |
| `ALLOW_INSECURE_SITE_URLS` | var | `"true"` permits `http://` **loopback only**, for local development |
| `ALLOW_SIGNUP` | var | `"false"` disables self-service signup (a bootstrap account can still be created) |
| `PBKDF2_ITERATIONS` | var | Password hashing work factor |
| `PAIRING_TTL_SECONDS`, `PROPOSAL_TTL_SECONDS` | var | Lifetimes |
| `SITE_CREDENTIAL_KEY` | **secret** | base64 of 32 random bytes; root key for site credentials |
| `SESSION_SECRET` | **secret** | Session id derivation, CSRF derivation, challenge hashing |
| `CONSENT_SECRET` | **secret** | HMAC key for the remembered-consent cookie (≥ 32 chars) |

### `bludit-wizard-mcp`

| Binding | Type | Purpose |
|---|---|---|
| `AUTH_SERVER` | Service binding | `validateToken` RPC to the authorization server |
| `DB` | D1 | Reads `sites` (with encrypted credentials) and `proposals`; writes `proposals` and `audit_log` |
| `AUTH_ISSUER`, `MCP_RESOURCE` | var | Must match the authorization server's values exactly |
| `SITE_CREDENTIAL_KEY` | **secret** | Same value as the authorization server's, for decryption |
| `PROPOSAL_TTL_SECONDS` | var | Lifetimes |

Secrets are set with `wrangler secret put` and never appear in a config file,
`.dev.vars` in version control, or a log line. The repository contains no
credential of any kind.

## Identity model

Four concepts, kept deliberately distinct:

| Concept | Stored in | Means |
|---|---|---|
| **Account** | D1 `users` | A person who signed up here. Not a Bludit user. |
| **OAuth client** | KV (library) | The application the person connected. |
| **Site** | D1 `sites` | One Bludit website, owned by one account. |
| **Grant** | KV (library) | One client's authorization for one account, carrying a scope set. |

A tool argument can only select among the caller's own sites. `ctx.props.userId`
comes from the token that the authorization server validated, never from the
request body, so there is no argument that widens access.

## Request flows

### Discovery

```
client ──▶ GET /mcp (no token)
        ◀── 401  WWW-Authenticate: Bearer realm="OAuth",
                 resource_metadata="https://…/.well-known/oauth-protected-resource",
                 scope="sites:read pages:read"
client ──▶ GET /.well-known/oauth-protected-resource
        ◀── 200  { resource, authorization_servers, resource_name }
client ──▶ GET {issuer}/.well-known/oauth-authorization-server
        ◀── 200  { issuer, authorization_endpoint, token_endpoint,
                   registration_endpoint, scopes_supported, … }
```

Nothing is hard-coded in the client: the resource metadata names the
authorization server, and the authorization server's metadata names the rest.

### Authorization

```
client ──▶ GET /authorize?response_type=code&client_id=…&code_challenge=…
                  &redirect_uri=…&scope=…&state=…&resource=…
        ◀── 302 /signin?next=…            (no session)
browser ─▶ POST /signin                  (PBKDF2 verify, session cookie)
        ◀── 303 /authorize?…
        ◀── 200 consent page             (client name, redirect host, scopes)
browser ─▶ POST /authorize/decision      (CSRF checked, scopes chosen)
        ◀── 303 {redirect_uri}?code=…&state=…&iss=…
client ──▶ POST /oauth/token              (code + code_verifier)
        ◀── 200 { access_token, refresh_token, scope, resource }
```

A remembered decision short-circuits the consent page but still runs
`completeAuthorization`, so a grant is always recorded. Approvals are bound to
the client, the redirect URI, the resource and the account, which is why
authorizing Claude does not authorize ChatGPT.

### Tool call

```
client ──▶ POST /mcp  Authorization: Bearer …
            │
            ├─ resource server: AUTH_SERVER.validateToken(resource, token)   [RPC]
            ├─ baseline scope check                        → 403 challenge if missing
            ├─ parse the JSON-RPC body, find tools/call names
            ├─ required-scope check for those tools        → 403 challenge if missing
            └─ build a per-request McpServer, dispatch
                 │
                 ├─ tool callback: requireToolScope(tool)   (defence in depth)
                 ├─ resolve the site by (user_id, reference)
                 ├─ decrypt credentials (in memory only)
                 ├─ fetch the Bludit API with the SSRF policy
                 ├─ write an audit row
                 └─ return the result, or a structured error
```

The 403 challenge names the **complete** scope set the operation needs, not just
the difference, because MCP clients treat the named list as exhaustive and ask
for exactly that. The baseline read scopes are included in every challenge.

### Site connection

```
browser ─▶ POST /sites/challenge     → one-time challenge, shown once
user     ─▶ publishes it at /.well-known/…, or points the Wizard extension at it
browser ─▶ POST /sites/connect
             │
             ├─ SSRF policy on the URL
             ├─ challenge must be unconsumed, unexpired, account-bound
             ├─ site must echo the challenge (HMAC proof, or ownership file)
             ├─ capability probe (reads only)
             ├─ encrypt + store credentials
             └─ consume the challenge last, so a failed store is retryable
```

A pasted API token is never accepted as proof of ownership.

## Data model

```
users(id, email UNIQUE, display_name, password_hash, status, created_at, updated_at)
sessions(id, user_id→users, created_at, expires_at, user_agent, ua_hash)
sites(id, user_id→users, label, base_url, edition, bludit_version,
      api_token_enc, auth_token_enc, wizard_api_key_enc, wizard_api_base,
      capabilities_json, status, last_error, created_at, updated_at, last_checked_at,
      UNIQUE(user_id, base_url))
pairing_challenges(id, user_id→users, challenge_hash, label, base_url,
      created_at, expires_at, consumed_at)
proposals(id, user_id→users, site_id→sites, page_key, base_revision, operation,
      payload_json, payload_hash, status, created_at, expires_at,
      applied_at, applied_by_client_id)
audit_log(id, user_id, site_id, client_id, tool, outcome, detail, created_at)
```

Notes:

- `sessions.id` is an HMAC of the session token, so a database leak does not
  yield a usable session.
- `pairing_challenges.id` is an HMAC of the challenge for the same reason.
- `*_enc` columns hold AES-256-GCM envelopes with the site id as additional
  authenticated data, so a ciphertext cannot be moved between rows.
- `proposals.base_revision` is the whole mechanism behind stale-approval
  rejection.
- `audit_log` deliberately has no content column: it records *that* a tool ran,
  not what it read.

D1 stores no page content. The only copy of a page lives in Bludit and,
transiently, in a tool result.

## Threat model

| Threat | Control |
|---|---|
| Unauthenticated access to MCP tools | Every request needs a token validated by the authorization server |
| One client reading another's data | Grants are per client + account; revocation is per grant |
| One account reading another's sites | Every site query is scoped by `user_id`; another account's site id resolves to `not_found`, not `forbidden` |
| A token minted for another resource | The validator checks the audience against the canonical resource |
| Stale approval overwriting a newer edit | `proposals.base_revision` is compared with the live page before applying |
| Cross-account proposal application | Proposal lookup is scoped by both `user_id` and `site_id` |
| SSRF via a site URL | Scheme/host policy, reserved-range denial, bounded redirects, and the platform's `global_fetch_strictly_public` flag |
| Credential disclosure | Encrypted at rest; never logged; never returned; decrypted only for one outbound call |
| Prompt injection widening access | Authorization is checked server-side from the token; tool text cannot grant a scope |
| Open redirect after sign-in | `safeNext` accepts same-origin absolute paths only |
| CSRF on consent or site mutation | CSRF token derived from the session, plus `SameSite=Lax` |
| Cookie theft | `__Host-` prefix on https, `HttpOnly`, session bound to the user agent |
| Irreversible data loss | No delete tool is exposed |

## Cloudflare limits and cost

Verified against Cloudflare's documentation on 2026-10-16 (see
`docs/DEPLOYMENT.md` for the source links).

### Workers plan limits

| Feature | Free | Paid (Standard) |
|---|---|---|
| Requests | 100,000/day | 10M/month included, +$0.30/M |
| CPU time per invocation | **10 ms** | 30 s default, 5 min max |
| Included CPU time | — | 30M CPU-ms/month, +$0.02/M |
| Subrequests per invocation | 50 | 10,000 |
| Simultaneous open connections | 6 | 6 |
| Environment variables per Worker | 64 | 128 |
| Worker size (uncompressed) | 64 MiB | 64 MiB |
| Workers per account | 100 | 500 |

### Storage limits

| Product | Free | Paid |
|---|---|---|
| KV reads | 100,000/day | 10M/month |
| KV writes (different keys) | **1,000/day** | 1M/month, +$5.00/M |
| KV storage | 1 GB | 1 GB, +$0.50/GB-mo |
| D1 rows read | 5M/day | 25B/month |
| D1 rows written | 100,000/day | 50M/month |
| D1 queries per Worker invocation | 50 | 1,000 |
| Rate limiting cost per request | 1 row read + 1 row write | same |
| D1 database size | 500 MB | 10 GB |
| D1 storage | 5 GB total | 5 GB, +$0.75/GB-mo |

### The free tier is not sufficient, and the reason is specific

**Password hashing needs more than 10 ms of CPU.** Sign-in runs PBKDF2-SHA256,
which is deliberately expensive: the default here is 600,000 iterations, which
takes hundreds of milliseconds of CPU. Cloudflare's own documentation notes that
workloads "that handle authentication … typically use 10–20 ms", already at or
over the Free plan's 10 ms ceiling.

**KV writes are the second blocker.** The Free plan allows 1,000 writes per day.
A single OAuth authorization writes several KV entries (client lookup, granting
records, code, token, refresh token), and every refresh writes again. A handful
of users reconnecting a few times a day could reach that ceiling, and DCR adds
another write per registration.

Lowering the iteration count to fit 10 ms would weaken password storage
disproportionately — say 5,000 iterations, which is well below current guidance —
and trading credential security for $5/month is a bad trade.

**Therefore: Workers Paid, $5 USD per month, is the realistic minimum.** That is
the whole recurring cost for a small deployment.

### Cost estimate

Assuming ~10 ms of CPU per request, which is generous for tool calls that are
mostly waiting on network I/O:

| Monthly MCP requests | Requests | CPU | KV / D1 | Total |
|---|---|---|---|---|
| 3,000 (personal use: a few clients, ~100 calls/day) | $0 | $0 | $0 | **$5.00** |
| 100,000 | $0 | $0 | $0 | **$5.00** |
| 1,000,000 | $0 | $0 | $0 | **$5.00** |
| 10,000,000 (at the included ceiling) | $0 | $0.00 (100M CPU-ms is 70M over → $1.40) | $0 | **$6.40** |
| 50,000,000 | $12.00 | $9.40 | $0 | **$26.40** |

KV writes are billed at $5.00 per million on Paid, so a million authorizations
per month would add $5. Cloudflare does not charge for egress or bandwidth on
Workers, Service Bindings, KV or D1, and D1 has no egress charge.

For comparison, an always-on VPS able to run the same workload would cost
noticeably more per month than the Workers Paid plan, and would need patching,
monitoring and backups. Nothing in this design requires it.

### Practical limits encoded in the code

Two limits are handled explicitly rather than left to fail at the platform:

1. **Subrequests.** Each page fetched for `search_pages` with `include_content`
   is a separate subrequest, and the Free plan allows 50 per invocation. The tool
   refuses a content scan above 40 pages with an explanatory error instead of
   tripping a platform limit mid-scan. `MAX_CONTENT_SCAN` in
   `src/mcp/tools/intelligence.ts` is where a Paid deployment would raise it.
2. **Zod memory.** Cloudflare documents that Zod below 4.5.0 uses substantially
   more memory per schema, and this server registers 19 tool schemas per request.
   The project pins Zod 4.6.7.

## Deliberate non-choices

- **No Durable Objects.** The MCP transport is stateless; there is no session to
  keep. A Durable Object would add a coordination primitive and a duration bill
  for no benefit.
- **No Queues, Workflows or R2.** Nothing here is asynchronous and no files are
  stored. Page content stays in Bludit.
- **No separate database for proposals.** They are small, short-lived and already
  scoped by `(user_id, site_id)` in `sites`' own database.
- **No VPS, Docker or always-on process.** Not needed for any part of this.
