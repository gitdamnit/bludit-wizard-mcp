# Local development and deployment

Nothing in this document has been executed against a real Cloudflare account.
Every command below is written to be followed deliberately, in order, by a human
who has reviewed it. Deploying, creating resources, and changing DNS all require
explicit approval — see the gates at the end.

## Prerequisites

| Requirement | Version used here | Notes |
|---|---|---|
| Node.js | 22.23.2 | `>=20` declared; 22 LTS is recommended |
| npm | 10.9.8 | npm 12.x is newer; see Toolchain notes |
| Cloudflare account | — | Workers Paid is required for a realistic deployment (`ARCHITECTURE.md` explains why the Free plan is not enough) |
| `wrangler` | 4.151.0 | installed as a dev dependency, so `npx wrangler` always matches |
| A Bludit site | 3.22.x | with the API plugin enabled |
| A domain | optional | `*.workers.dev` works for the first deployment |

```bash
npm ci
npm run typecheck
npm test
```

## Local development

Two local secrets files, one per Worker, both git-ignored. `SITE_CREDENTIAL_KEY`
must be **identical** in both, because the authorization server encrypts what the
resource server decrypts.

```bash
cp .dev.vars.example .dev.vars
node -e "console.log('SITE_CREDENTIAL_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('CONSENT_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Put the same values in a `.dev.vars` next to each config, or export them, then:

```bash
# Terminal 1
npm run dev:auth     # http://localhost:8787

# Terminal 2
npm run dev:mcp      # http://localhost:8788
```

Both use `--persist-to .wrangler/state`, so they share one local D1 database.
Apply the schema once:

```bash
npm run db:migrate:local
```

To sign in locally you need an account. With no users present, `/signup` is open
even when `ALLOW_SIGNUP=false`, which is how the first account bootstraps:

1. Open `http://localhost:8787/` and create an account.
2. Go to **Connected sites → Connect a Bludit site**, generate a pairing
   challenge, and either publish it at
   `https://your-site/.well-known/bludit-wizard-challenge.txt` or point the
   Wizard extension at it.
3. Enter the Bludit API token, the user auth token, and (optionally) the Wizard
   GPT Action key.

To reach a Bludit site running on `http://127.0.0.1` during development, set
`ALLOW_INSECURE_SITE_URLS=true` in **both** dev vars. That flag permits loopback
only; it never permits a LAN address or a public host over plain http.

## Deploying

### Gate 1 — resource creation

```bash
# The KV namespace the OAuth provider owns.
npx wrangler kv namespace create OAUTH_KV

# The shared database.
npx wrangler d1 create bludit-wizard-mcp
```

Copy the returned ids into `wrangler.auth.jsonc` and `wrangler.mcp.jsonc`,
replacing `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` and `REPLACE_WITH_D1_DATABASE_ID`.
The `database_id` must match in both files; the KV id appears only in the
authorization server's config.

Then point both configs at the real hostnames:

```jsonc
// wrangler.auth.jsonc
"vars": {
  "AUTH_ISSUER": "https://mcp.example.com",
  "MCP_RESOURCE": "https://mcp.example.com/mcp",
  "ALLOW_INSECURE_SITE_URLS": "false"
}
```

```jsonc
// wrangler.mcp.jsonc — must match exactly
"vars": {
  "AUTH_ISSUER": "https://mcp.example.com",
  "MCP_RESOURCE": "https://mcp.example.com/mcp",
  "ALLOW_INSECURE_SITE_URLS": "false"
}
```

Note that `AUTH_ISSUER` and `MCP_RESOURCE` are the same origin here. That is not
required — the design supports the authorization server on its own hostname (the
split-Workers shape in `ARCHITECTURE.md`) — but one hostname is simpler for a
single domain and keeps the consent page and the MCP endpoint under one
certificate. If you do split them, `AUTH_ISSUER` and `MCP_RESOURCE` differ and
the resource metadata advertises the former.

The OAuth library requires `http` only on a loopback host, so `AUTH_ISSUER`
**must** be an `https://` URL in production.

### Gate 2 — secrets

```bash
npx wrangler secret put SITE_CREDENTIAL_KEY --config wrangler.auth.jsonc
npx wrangler secret put SESSION_SECRET        --config wrangler.auth.jsonc
npx wrangler secret put CONSENT_SECRET        --config wrangler.auth.jsonc

npx wrangler secret put SITE_CREDENTIAL_KEY   --config wrangler.mcp.jsonc
```

Use the **same** `SITE_CREDENTIAL_KEY` value for both. Generate it once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Secrets are write-only: Wrangler cannot read them back, so keep a copy in a
password manager. Losing `SITE_CREDENTIAL_KEY` means every connected site must be
reconnected, because the stored credentials become undecryptable.

### Gate 3 — schema

```bash
npx wrangler d1 migrations apply bludit-wizard-mcp --remote --config wrangler.auth.jsonc
```

Idempotent: `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
throughout.

### Gate 4 — deploy, authorization server first

The resource server's `services` binding refers to the authorization server by
name, so the name must exist first.

```bash
npm run build:auth && npm run build:mcp      # dry-run builds, no network
npx wrangler deploy --config wrangler.auth.jsonc
npx wrangler deploy --config wrangler.mcp.jsonc
```

Optionally schedule the cleanup cron. Both Workers implement `scheduled()`, which
purges expired sessions, pairing challenges and proposals:

```jsonc
// wrangler.auth.jsonc
"triggers": { "crons": ["17 3 * * *"] }
```

### Gate 5 — DNS

Only after the Workers are verified on their `workers.dev` hostnames. A custom
domain requires the zone to be in the same Cloudflare account.

```jsonc
// wrangler.auth.jsonc and wrangler.mcp.jsonc
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }],
"workers_dev": false
```

Adding a route is a DNS change. Do not do it in the same step as anything else,
so a failure has one cause.

### Verification after deploying

```bash
BASE=https://mcp.example.com

curl -s $BASE/healthz | jq

# The MCP resource must challenge an unauthenticated request.
curl -s -o /dev/null -D - $BASE/mcp | grep -i www-authenticate

# Metadata must resolve and name the right issuer and resource.
curl -s $BASE/.well-known/oauth-authorization-server | jq '{issuer, authorization_endpoint, token_endpoint, scopes_supported, client_id_metadata_document_supported}'
curl -s $BASE/.well-known/oauth-protected-resource | jq

# The consent page must render.
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/authorize?response_type=code&client_id=x&redirect_uri=https://example.com/cb"
```

Then connect a real MCP client and complete one end-to-end call. A first
deployment should be verified with a Bludit site you are willing to reconnect if
something goes wrong.

## Rollback

Workers keeps every version, so a bad deploy is reverted by redeploying the
previous one:

```bash
npx wrangler versions list --config wrangler.mcp.jsonc
npx wrangler rollback --config wrangler.mcp.jsonc
```

Schema changes are the hard part: `0001_init.sql` is additive only, so a code
rollback needs no schema rollback. A future destructive migration would need a
two-step deploy (add, then remove) so both versions work during the window. D1
Time Travel gives 7 days of point-in-time recovery on the Free plan and 30 on
Paid.

## Environment variables reference

| Variable | Worker | Required | Notes |
|---|---|---|---|
| `AUTH_ISSUER` | both | yes | Public `https://` origin of the authorization server. Must match in both. |
| `MCP_RESOURCE` | both | yes | Canonical resource identifier. Must match in both. |
| `AUTH_SERVER` | mcp | yes | Service binding; not a var. |
| `SITE_CREDENTIAL_KEY` | both | yes | Secret. Same value in both. |
| `SESSION_SECRET` | auth | yes | Secret, ≥ 32 chars. Rotating it invalidates all sessions and CSRF tokens, and outstanding pairing challenges. |
| `CONSENT_SECRET` | auth | yes | Secret, ≥ 32 chars (the OAuth library rejects shorter). Rotating it forgets remembered consents. |
| `ALLOW_INSECURE_SITE_URLS` | both | no | `"true"` permits loopback http. **Leave unset in production.** |
| `ALLOW_SIGNUP` | auth | no | `"false"` closes self-service signup. The first account can still be created. |
| `PBKDF2_ITERATIONS` | auth | no | Default 600,000. Lower only for tests. |
| `PAIRING_TTL_SECONDS` | auth | no | Default 900. |
| `PROPOSAL_TTL_SECONDS` | both | no | Default 900. |
| `CREDENTIAL_KEY_VERSION` | both | no | Default 1. Recorded on each grant, for future key rotation. |

## Key rotation

`SITE_CREDENTIAL_KEY` cannot be rotated without re-encrypting the existing rows,
because each ciphertext is keyed by a single secret. `CREDENTIAL_KEY_VERSION` is
already recorded on every grant so a future rotation can be staged: add the new
key alongside the old, re-encrypt lazily as each site is used, then remove the old
key. That re-encryption job does not exist yet — see "Remaining work" in
`SECURITY.md`.

## Testing profiles

Four sets of Wrangler configs exist for testing. None is deployable.

| Config | Purpose |
|---|---|
| `wrangler.auth.jsonc` / `wrangler.mcp.jsonc` | The deployable configuration (placeholders for ids) |
| `wrangler.auth.test.jsonc` / `wrangler.mcp.test.jsonc` | Test profile without the `global_fetch_strictly_public` flag, so the Workers can reach the loopback mock Bludit server |
| `wrangler.auth.prodshape.jsonc` / `wrangler.mcp.prodshape.jsonc` | Test profile **with** the production compatibility flag, to prove the production shape still discovers, authorizes and refuses loopback sites |
| `wrangler.schema.test.jsonc` / `wrangler.schema.prodshape.jsonc` | Test-only Worker that applies the schema and answers read-only queries |

The `*_comment` keys in the test configs are inert JSON and exist to make the
intent obvious to anyone who opens them.

## Toolchain notes

### The `legacy-peer-deps` flag

`.npmrc` sets `legacy-peer-deps=true`. Without it, `npm install` crashes on
npm 10.9.8:

```
npm error Cannot read properties of null (reading 'edgesOut')
  at #loadPeerSet (…/@npmcli/arborist/lib/arborist/build-ideal-tree.js:1289:38)
```

Reproduce with a clean tree: `rm -rf node_modules package-lock.json && npm install`.
It reproduces with `vitest` alone in an empty project, so it is an arborist bug
in peer-set resolution, not a conflict in this dependency set — all runtime
dependencies install cleanly without the flag. Confirm on a newer npm (12.x is
current) and delete the flag and this note when it no longer reproduces.

### TypeScript is pinned to 5.9.3

TypeScript 7.0.2 is current, but `@cloudflare/workers-types`,
`@cloudflare/vitest-pool-workers` conventions and Wrangler 4 are built and tested
against the 5.x line. Moving to 7 should be its own change with its own review.

### Node and Workers type coexistence

`tsconfig.json` includes both `@cloudflare/workers-types` and `@types/node`,
because the test harness starts a Node HTTP server *and* drives Workers handlers.
Where the two `Response` types differ nominally, the test helpers use the
structural `AnyResponse` interface in `test/harness/response.ts` rather than casts.

## Source of the platform figures

Limits and pricing in `ARCHITECTURE.md` were read from Cloudflare's documentation
on 2026-10-16:

- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/kv/platform/limits/>
- <https://developers.cloudflare.com/d1/platform/limits/>

## Approval gates

These steps are deliberately left for a human to authorize explicitly:

1. Creating any Cloudflare resource (KV namespace, D1 database).
2. Setting any secret in a real Cloudflare account.
3. Applying migrations to a remote database.
4. Deploying either Worker.
5. Adding a route or custom domain, i.e. any DNS change.
6. Enabling Workers Paid, or any other change with a recurring cost.
7. Publishing the repository, the npm package, or either plugin directory listing.

Nothing in this repository performs any of them automatically. `.github/workflows/ci.yml`
typechecks, tests and dry-run builds only; it has no deploy step and no
credentials.
