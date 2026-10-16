# Deployment readiness

**Status: ready to deploy, pending your approval.** Nothing has been created,
deployed, published, or paid for. This document is the gate.

| | |
|---|---|
| Branch | `feat/remote-mcp-oauth-v1` |
| Tests | **428 passing** — 395 hermetic, 24 against real Bludit, 9 in a browser |
| Typecheck | Clean, with `noUnusedLocals` |
| Worker builds | `wrangler deploy --dry-run` succeeds for both |
| Rate limiting | Eleven buckets, audited against every mutating and expensive endpoint |
| Blocking defects open | None |

## 1. Exact Cloudflare resource requirements

| # | Resource | Type | Count | Notes |
|---|---|---|---|---|
| 1 | `OAUTH_KV` | Workers KV namespace | 1 | Owned by the OAuth provider: clients, grants, codes, refresh tokens, consent transactions |
| 2 | `bludit-wizard-mcp` | D1 database | 1 | Bound by **both** Workers. Created once, bound twice |
| 3 | `bludit-wizard-auth` | Worker | 1 | Authorization server. Deploy first: it is the Service Binding target |
| 4 | `bludit-wizard-mcp` | Worker | 1 | MCP resource server |
| 5 | `SITE_CREDENTIAL_KEY` | Secret | 1 value in 2 Workers | **Same value in both.** base64 of 32 random bytes |
| 6 | `SESSION_SECRET` | Secret | 1 | Auth Worker only. ≥ 32 characters |
| 7 | `CONSENT_SECRET` | Secret | 1 | Auth Worker only. ≥ 32 characters |
| 8 | Cron trigger | Optional | 1 | Purges expired sessions, challenges, proposals and counters. Not required to function |
| 9 | DNS record | **Not now** | 0 | `workers.dev` only. A custom domain is a later, separately approved step |

No R2 bucket, no Durable Object, no Queue, no Workflow, no Container, no
Hyperdrive, no Vectorize. Nothing outside Cloudflare, and no third-party service.

**One D1 binding to note:** both Workers bind the same `database_id`. Get it wrong
in one file and that Worker fails at runtime rather than at deploy, which is why
`test/unit/production-config.test.ts` asserts the two configs agree.

## 2. Expected initial cost

| Item | Dev scale | Included allowance | Cost |
|---|---|---|---|
| Workers Paid subscription | — | — | **$5.00 / month** |
| Requests | a few thousand | 10 M / month | $0 |
| CPU time | well under 1 M ms | 30 M CPU-ms / month | $0 |
| D1 rows read | thousands | 25 B / month | $0 |
| D1 rows written | thousands | 50 M / month | $0 |
| D1 storage | under 1 MB | 5 GB | $0 |
| KV reads | thousands | 10 M / month | $0 |
| KV writes | hundreds | 1 M / month | $0 |
| Egress / bandwidth | — | not charged by Cloudflare | $0 |
| **Total** | | | **$5.00 / month** |

There is no per-request charge on the included allowance, no egress charge on
Workers, KV or D1, and no charge for the Service Binding between the two Workers.

### The free plan will not work, and the reason is specific

Sign-up and sign-in run PBKDF2-SHA256. The default is 600,000 iterations, which is
hundreds of milliseconds of CPU. Cloudflare's free plan allows **10 ms of CPU per
invocation**, so the first sign-in returns error `1102 Worker exceeded resource
limits`. Cloudflare's own documentation notes that authentication workloads
"typically use 10–20 ms", already over the ceiling before any hashing.

The free plan's **1,000 KV writes per day** is the second blocker: each OAuth
authorization and refresh writes several KV entries.

Lowering `PBKDF2_ITERATIONS` to fit 10 ms would mean a few thousand iterations,
well below current guidance, which trades password security for $5 a month. If you
want to see the failure for yourself rather than take it on trust, deploy on the
free plan first and attempt a sign-up; you should get error 1102, and that is the
honest demonstration. **The recommendation is Workers Paid.**

## 3. Remaining accepted risks

### Would not block a development deployment

| Risk | Note |
|---|---|
| Both Workers share `SITE_CREDENTIAL_KEY` | Required for the resource server to decrypt; the alternative is proxying every CMS call |
| KV eventual consistency on revocation | Bounded by the one-hour access-token TTL and typically under 60 seconds |
| The platform SSRF layer cannot be probed locally | Verified by configuration and by the post-deployment checks below |
| `get_website_settings` needs an admin auth token | Bludit's own rule, disclosed in the capability report |
| The Wizard pairing contract is proposed, not implemented in PHP | The ownership-file path is complete and plugin-free |
| Only Bludit 3.22.0 is live-verified | Later 3.22.x patches are modelled |
| A personal access token is a long-lived bearer credential | Bounded by user-chosen scopes, 90-day default expiry, immediate revocation, per-token audit, and no delete capability (ADR-020) |
| A `workers.dev` hostname is shared infrastructure | Fine for development. Not appropriate for a public launch |

### Would block a public launch, not this deployment

1. **No MFA on service accounts.** Account takeover is website takeover.
2. **No password reset.** A user who forgets a password has no route back in; needs an email provider, which is a new external service and a new approval.
3. **No MCP client verified.** Twelve are researched; none is tested.
4. **No alerting.** `429` volume, Worker errors and D1 growth are visible in the dashboard but page nobody.
5. **No credential key rotation.** A suspected key compromise means reconnecting every site.
6. **No `/.well-known/security.txt`.** Needed for coordinated disclosure.

## 4. Safe deploy sequence

Every step is reversible, and nothing touches DNS.

### Step 0 — generate three secrets locally, and store them

```bash
node -e "console.log('SITE_CREDENTIAL_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('CONSENT_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Keep all three in a password manager **before** continuing. Wrangler cannot read a
secret back, and losing `SITE_CREDENTIAL_KEY` means every connected site must be
reconnected.

### Step 1 — create the two resources

```bash
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create bludit-wizard-mcp
```

Record both ids.

### Step 2 — put the ids and the hostnames into both configs

Replace `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` in `wrangler.auth.jsonc` and
`REPLACE_WITH_D1_DATABASE_ID` in **both** configs.

Then set the issuer and the resource to the **workers.dev** hostnames. Two Workers
means two origins, which the design supports and ADR-014 already anticipated as a
configuration change rather than a redesign.

```jsonc
// wrangler.auth.jsonc
"vars": {
  "AUTH_ISSUER": "https://bludit-wizard-auth.<your-subdomain>.workers.dev",
  "MCP_RESOURCE": "https://bludit-wizard-mcp.<your-subdomain>.workers.dev/mcp",
  "ALLOW_INSECURE_SITE_URLS": "false"
}
```

```jsonc
// wrangler.mcp.jsonc — the same two values, character for character
"vars": {
  "AUTH_ISSUER": "https://bludit-wizard-auth.<your-subdomain>.workers.dev",
  "MCP_RESOURCE": "https://bludit-wizard-mcp.<your-subdomain>.workers.dev/mcp",
  "ALLOW_INSECURE_SITE_URLS": "false"
}
```

Both must be `https`, and `test/unit/production-config.test.ts` now asserts they
match between the two files and use https — but it cannot know your subdomain, so
replace the placeholder carefully.

Their real names appear in the deploy output, or in the dashboard. The Worker
`name` fields are already `bludit-wizard-auth` and `bludit-wizard-mcp`.

### Step 3 — set the four secrets

```bash
npx wrangler secret put SITE_CREDENTIAL_KEY --config wrangler.auth.jsonc
npx wrangler secret put SESSION_SECRET        --config wrangler.auth.jsonc
npx wrangler secret put CONSENT_SECRET        --config wrangler.auth.jsonc
npx wrangler secret put SITE_CREDENTIAL_KEY   --config wrangler.mcp.jsonc
```

The same `SITE_CREDENTIAL_KEY` value both times.

### Step 4 — apply the schema

```bash
npx wrangler d1 migrations apply bludit-wizard-mcp --remote --config wrangler.auth.jsonc
```

Three migrations, all additive, all idempotent.

### Step 5 — build, then deploy the authorization server first

```bash
npm run build:auth && npm run build:mcp      # dry-run, no network
npx wrangler deploy --config wrangler.auth.jsonc
npx wrangler deploy --config wrangler.mcp.jsonc
```

The authorization server must exist before the resource server, because
`bludit-wizard-mcp` binds to it by name.

### Step 6 — verify before touching anything else

```bash
AUTH=https://bludit-wizard-auth.<sub>.workers.dev
MCP=https://bludit-wizard-mcp.<sub>.workers.dev

curl -s $AUTH/healthz | jq
curl -s -o /dev/null -D - $MCP/mcp | grep -i www-authenticate
curl -s $AUTH/.well-known/oauth-authorization-server | jq '{issuer, authorization_endpoint, token_endpoint, registration_endpoint, scopes_supported, client_id_metadata_document_supported}'
curl -s $MCP/.well-known/oauth-protected-resource | jq
curl -s -o /dev/null -w '%{http_code}\n' "$AUTH/signin"
```

Expected: `{"ok":true}`, a `401` carrying `resource_metadata` and `scope`,
`client_id_metadata_document_supported: true`, a resource naming the auth origin,
and `200` for the sign-in page.

### Step 7 — end-to-end, with a real site

1. Sign up at `$AUTH/signup`. **If this returns error 1102, the plan is the problem, not the code.** See §2.
2. Connect a **public HTTPS Bludit 3.22.x** site through the pairing flow, publishing the challenge at `/.well-known/bludit-wizard-challenge.txt` or using the Wizard extension key.
3. Create a personal access token, and call `$MCP/mcp` with it:

```bash
curl -s -X POST "$MCP/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
```

Expected: `19`.

4. Then connect one MCP client from `docs/CLIENT_SETUP_GUIDES.md`.

> A `workers.dev` deployment **must use a publicly reachable HTTPS Bludit site.**
> The production compatibility flag blocks private addresses, and
> `ALLOW_INSECURE_SITE_URLS` cannot override it, so a loopback or LAN site will not
> work here. That is the platform layer of the SSRF defence doing its job.

### Step 8 — rollback, if anything is wrong

```bash
npx wrangler versions list --config wrangler.mcp.jsonc
npx wrangler rollback --config wrangler.mcp.jsonc
```

The three migrations are additive, so a code rollback needs no schema rollback.
Deleting the KV namespace and the D1 database removes every trace. Nothing outside
Cloudflare is affected.

## 5. Already reviewed at this gate

| Item | Outcome |
|---|---|
| Rate limiting on OAuth endpoints, DCR, PAT management, pairing, MCP | Audited. Four endpoints were **unprotected** — sign-up, token creation, consent decisions, capability checks — and are now bounded, plus an aggregate per-account MCP limit. Revocation is deliberately unbounded. |
| OAuth token issuance, refresh, revocation | Covered by `oauth-security.test.ts`; unchanged. |
| PAT expiration | Enforced on every request, not only in the UI; asserted. |
| Credential encryption | AES-256-GCM, site id as additional data, ciphertext read back out of real D1, fresh IV verified. |
| Cross-account isolation | Twelve probes with another account's site id, all `not_found`; asserted for both credential types. |
| Audit logging | New `audit-review.test.ts`: one row per call, credential identifier recorded, failure recorded as a code not a message, and nothing sensitive in the trail. |
| PAT cannot bypass OAuth-equivalent scopes, site permissions, approvals, or no-delete | Asserted: same scope enforcement, same tenancy, no-confirm refusal, no delete tool, cannot act as a session, cannot widen its own scopes. |
| HTTP transport and tool annotations | `protocol-surface.test.ts` unchanged and passing — 19 tools with all four annotation hints, four `Accept` variants, old and new protocol revisions, no session id, no legacy `/sse`. The 27-surface compatibility work did not regress. |

## 6. Approval gate

This is where the work stops. Each line needs your explicit go-ahead.

- [ ] **Create 1 KV namespace and 1 D1 database** (free-tier resources, no charge)
- [ ] **Accept the Workers Paid plan at $5/month**, required for sign-in to work
- [ ] **Set 4 secrets** in the Cloudflare account for these two Workers
- [ ] **Apply 3 migrations** to the remote D1 database
- [ ] **Deploy 2 Workers** to `workers.dev` hostnames
- [ ] **Connect one real Bludit 3.22.x site** for the end-to-end check
- [ ] **Connect one MCP client** from the setup guides, and record the result

Deliberately **not** requested, and not to be done in this step: a custom domain, a
DNS change, publication anywhere, an OpenAI submission, or any resource outside
Cloudflare.

## 7. Immediate follow-ups after a successful deployment

1. Replace the platform hostnames with `mcp.evanzellner.com` as a separately approved DNS step, and set `AUTH_ISSUER` and `MCP_RESOURCE` to that single origin, as ADR-014 intends.
2. Verify one client per credential type and record both in `CLIENT_COMPATIBILITY_MATRIX.md`. Every "tested version" cell currently says `not tested`; this is the change that matters most.
3. Re-run `docs/CLIENT_SETUP_GUIDES.md`'s diagnostic against any client that fails, and record the outcome either way.
4. Enable the cron trigger, and confirm the cleanup runs.
5. Work the public-launch blockers in §3 in order, starting with MFA and password reset.
