# Bludit Wizard MCP

A universal remote MCP server for [Bludit CMS](https://www.bludit.com). Connect
the Bludit websites you own to any MCP-compatible AI client, and read, draft and
update their pages over OAuth 2.1 — with a review step before anything changes.

Runs on Cloudflare Workers. Streamable HTTP. No model of its own, no page content
stored, no credentials in the clear.

> **Status: pre-release, not deployed.** The implementation and its test suite are
> complete: **411 tests passing**, including 24 against real Bludit Community and
> real Bludit Pro 3.22.0 installations. It has **not** been deployed, and **no MCP
> client product has been verified** against it — twelve are researched from
> official documentation and none is tested. Both gaps are stated in
> [Verified vs. not](#verified-vs-not) and in
> [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md). Nothing here claims otherwise.

## What it is

| | |
|---|---|
| Transport | MCP Streamable HTTP, stateless |
| Authorization | OAuth 2.1: Authorization Code + PKCE, refresh tokens, revocation, DCR, CIMD |
| Platform | Cloudflare Workers, two Workers, D1 + KV |
| Tools | 19 |
| Rate limiting | D1-backed, on every public entry point |
| Inference | none — this server calls no model |
| Licence | MIT, derived from [`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) |

## Contents

- [Architecture](#architecture)
- [Tools](#tools)
- [Connecting a client](#connecting-a-client)
- [Connecting a Bludit site](#connecting-a-bludit-site)
- [Running it yourself](#running-it-yourself)
- [Verified vs. not](#verified-vs-not)
- [Differences from the official Bludit MCP server](#differences-from-the-official-bludit-mcp-server)
- [Differences from the native Bludit Wizard plugin](#differences-from-the-native-bludit-wizard-plugin)
- [Security](#security)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Licence and attribution](#licence-and-attribution)

## Architecture

Two Workers, so that minting a token and reading a customer's page content are
different trust boundaries:

```
MCP client ──▶ bludit-wizard-mcp (resource server) ──docs──▶ Bludit site /api/*
                    │  OAuth 2.1 token validation
                    │  Streamable HTTP, 19 tools
                    ▼  Service Binding (validateToken)
              bludit-wizard-auth (authorization server) ──▶ Bludit site (pairing proof)
                    │  OAuth discovery, token, revocation, DCR
                    │  consent, accounts, sessions, site management UI
                    ▼
                 D1 (accounts, sites, proposals, audit)  +  KV (grants, tokens)
```

The resource server learns identity only from a validated token, never from tool
arguments. Every site and proposal lookup is scoped by account, so a tool argument
can only select among the caller's own sites.

Full detail, including the cost estimate and why the Workers free tier is not
enough: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tools

19 tools. Page deletion is **not** among them, deliberately —
see [docs/SECURITY.md](docs/SECURITY.md).

| Tool | Scopes | Kind |
|---|---|---|
| `list_sites` | `sites:read` | Service state |
| `select_site` | `sites:read` | Service state |
| `get_site_capabilities` | `sites:read` | Deterministic probes |
| `get_website_settings` | `settings:read` | CMS read |
| `list_pages` | `pages:read` | CMS read |
| `get_page` | `pages:read` | CMS read |
| `get_drafts` | `pages:read` | CMS read |
| `get_scheduled_pages` | `pages:read` | CMS read |
| `list_categories` | `pages:read` | CMS read |
| `list_tags` | `pages:read` | CMS read |
| `search_pages` | `pages:read` | Deterministic |
| `get_content_summary` | `pages:read` | Deterministic |
| `get_related_pages` | `pages:read` | Deterministic |
| `preview_page_changes` | `pages:read` | Deterministic |
| `verify_page_update` | `pages:read` | CMS read |
| `create_page` | `pages:write` | CMS write |
| `edit_page` | `pages:write` | CMS write |
| `propose_page_edit` | `pages:write` | Proposal |
| `apply_approved_edit` | `pages:write` | Proposal + CMS write |

Every tool is documented in [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md), including the
difference between a real CMS action, a deterministic computation, and a proposal.

Two write paths exist on purpose. `create_page` and `edit_page` write
immediately and read the page back to confirm. `propose_page_edit` →
`apply_approved_edit` records an immutable, revision-pinned proposal and refuses
to apply it if the page changed in the meantime, so a reviewed change can never
quietly overwrite someone else's newer edit.

## Connecting a client

Point any MCP client that supports remote servers at:

```
https://mcp.example.com/mcp
```

The client discovers the rest. It will be sent to a consent page showing the
client's name, the host the token will be returned to, and the permissions being
requested. You can grant fewer than were asked for.

**Which clients actually work?** Unknown — none has been tested. See
[docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md) for the verification
procedure and the hazards to watch for. No client is claimed as supported.

Clients that only speak stdio can use the retained upstream server instead
(`npm run start:stdio`), which serves one site from environment variables.

## Connecting a Bludit site

1. Enable the API plugin in Bludit: **Admin → Plugins → API**.
2. Collect the **API token** (Admin → Plugins → API → Settings) and the
   **user auth token** (Admin → Users → your user → Security → Token). The auth
   token is optional; without it the site is read-only.
3. Sign in to this service, choose **Connect a Bludit site**, and generate a
   pairing challenge.
4. Prove you control the site, in one of two ways:
   - **With the Bludit Wizard plugin**: enter its *GPT Action API key*, and the
     plugin answers the challenge for you.
   - **Without any plugin**: publish the challenge, alone, at
     `https://your-site/.well-known/bludit-wizard-challenge.txt`.
5. Enter the site URL and tokens and connect.

A pasted API token is never accepted as proof of ownership, which is what stops
one account from claiming a site that belongs to someone else.

## Running it yourself

```bash
npm ci
npm run typecheck
npm test                     # 378 tests, hermetic: no network, no Docker, no credentials
npm run test:browser         # 9 more, Playwright against the same in-process Workers
npm run build:auth           # dry-run build, no network
npm run build:mcp
```

Against real Bludit installations, using Docker only to host them:

```bash
PRO_ZIP=/path/to/bludit-pro-3.22.0.zip scripts/live-bludit-up.sh both
npm run test:live            # 24 tests against the real CMS
scripts/live-bludit-up.sh --down
```

Local development with two Workers:

```bash
cp .dev.vars.example .dev.vars   # fill in three generated secrets
npm run db:migrate:local
npm run dev:auth                 # terminal 1 — http://localhost:8787
npm run dev:mcp                  # terminal 2 — http://localhost:8788
```

Deployment, including the resource creation, secrets, migration, ordering and
approval gates, is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Nothing in this
repository deploys, creates resources, or changes DNS on its own.

Cost: **$5/month** (Workers Paid) for a small deployment. The free tier is not
sufficient, for a specific reason — password hashing needs more than its 10 ms CPU
allowance. The arithmetic is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Verified vs. not

This project takes the difference seriously.

**Verified by automated tests** (411 tests, all passing):

- The SSRF policy, including IPv4-mapped, NAT64, 6to4 and obfuscated literals.
- Credit-card-style credential handling: encryption, additional-data binding,
  password hashing, redaction.
- The Bludit API client's transport rules and error mapping.
- The full OAuth path in real workerd: discovery → DCR → PKCE → consent → token →
  `tools/list` → `tools/call` → scope step-up → refresh → revocation.
- Per-client and per-account isolation, cross-account proposal rejection.
- The pairing flow, including challenge reuse, wrong challenge, and a misbehaving
  Wizard extension.
- 19 tools end to end against a faithful mock of the Bludit 3.22.x API.
- Both Workers under the production compatibility flag.
- **14 operations against real Bludit Community 3.22.0 and real Bludit Pro
  3.22.0**, including create, edit, and the full propose → preview → apply →
  verify path, with a stale approval correctly refused.
- **Community and Pro are byte-identical** in `bl-plugins/api/plugin.php` and every
  kernel file the API depends on, so no feature is edition-gated.

**Not verified, and not claimed:**

- No real MCP client product has been used. The protocol is proven by a
  specification-following client in the harness; no product has been connected.
- The live Bludit installations are loopback over plain http, so the production
  SSRF policy and TLS are not exercised by them.
- The Bludit Wizard PHP extension has not been live-tested.
- Nothing has been deployed.

Live testing earned its keep immediately: it found that Bludit sends `tags` as a
comma-joined **string** rather than an array, which the mock had wrong and which
made `search_pages` fail on a real site.

[docs/TEST_REPORT.md](docs/TEST_REPORT.md) records the environment, commit,
versions, measured results and limitations.
[docs/BLUDIT_COMPATIBILITY_MATRIX.md](docs/BLUDIT_COMPATIBILITY_MATRIX.md) labels
every compatibility cell.

## Differences from the official Bludit MCP server

Full account, including a file-by-file provenance table and the pinned upstream
commit: [docs/UPSTREAM_COMPARISON.md](docs/UPSTREAM_COMPARISON.md).

| | Official `bludit-mcp` | This |
|---|---|---|
| Transport | stdio | Streamable HTTP |
| Identity | possession of the process | OAuth 2.1, per-account and per-client |
| Sites | one, from env vars | many, per account |
| Tools | 6 (incl. `delete_page`) | 19, no deletion |
| Credentials | in the environment | encrypted at rest, never logged |
| Concurrency | none | revision identifiers, stale-approval rejection |
| Review workflow | none | propose → preview → apply → verify |
| Capability reporting | none | `get_site_capabilities` |
| Tests | none | 411 |

The upstream stdio server is retained unchanged so existing users are not broken.

## Differences from the native Bludit Wizard plugin

[`Bludit Wizard`](docs/PHP_WIZARD_INTEGRATION.md) is a separate, native PHP plugin
that adds an AI-assisted admin interface inside Bludit.

| | Native PHP Wizard | This service |
|---|---|---|
| Runs | inside Bludit, as a plugin | on Cloudflare, separate from the site |
| Inference | calls the provider *you* configure (OpenAI, Ollama, OpenRouter, any OpenAI-compatible endpoint) | **none** — no model, no provider key |
| Needs | PHP 8+, cURL, your API key | an OAuth account here |
| Works with | Bludit's own admin UI, Custom GPT Actions | any MCP client |
| Depends on the other | no | no |

They are independent, and both stay that way. The hosted service works with the
official Bludit API alone; the Wizard plugin is optional and only ever improves
the connection step and the capability report. The PHP plugin is not modified by
this project. Where this service would benefit from an interface the plugin does
not yet expose, the contract is *proposed* in
[docs/PHP_WIZARD_INTEGRATION.md](docs/PHP_WIZARD_INTEGRATION.md) rather than
invented in code.

## Security

Summarised here; the full model, findings and accepted risks are in
[docs/SECURITY.md](docs/SECURITY.md).

- Site credentials are AES-256-GCM encrypted with a Worker secret, with the site
  id as additional authenticated data. Plaintext exists only inside one request.
- SSRF defence in four layers: the platform's `global_fetch_strictly_public`
  flag, a static URL policy, redirect revalidation, and response bounds.
- Every tool enforces its scopes server-side, twice — once in the HTTP pre-flight
  and once inside the tool.
- Proposals are bound to an account and a site and pinned to a page revision.
- Logs redact anything credential-shaped; errors never carry a secret.
- **Page deletion is not exposed.** Bludit has no soft delete, so an
  agent-driven delete would be unrecoverable.
- **Every public entry point is rate limited** — sign-in, authorization, token,
  registration, pairing, connection and MCP requests — with counters that store no
  IP address and no email address.
- The repository contains no secret. `.dev.vars.example` has variable names and
  empty values only.

Report a vulnerability privately — see [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Topology, why two Workers, bindings, data model, threat model, cost |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local development, resource creation, deployment order, approval gates |
| [SECURITY.md](docs/SECURITY.md) | Security model, findings, accepted risks, remaining work |
| [MCP_TOOLS.md](docs/MCP_TOOLS.md) | Every tool, its scopes, and its error codes |
| [UPSTREAM_COMPARISON.md](docs/UPSTREAM_COMPARISON.md) | Exactly what came from upstream, and every behavioural difference |
| [PHP_WIZARD_INTEGRATION.md](docs/PHP_WIZARD_INTEGRATION.md) | The PHP plugin's API, and the contracts this server needs from it |
| [BLUDIT_COMPATIBILITY_MATRIX.md](docs/BLUDIT_COMPATIBILITY_MATRIX.md) | Editions, versions and modelled feature combinations |
| [CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md) | How to verify an MCP client, and what is unverified |
| [TEST_REPORT.md](docs/TEST_REPORT.md) | Measured results, environment, limitations |
| [OPENAI_PUBLICATION_CHECKLIST.md](docs/OPENAI_PUBLICATION_CHECKLIST.md) | Publication readiness, test cases, remaining steps |
| [CLIENT_COMPATIBILITY_MATRIX.md](docs/CLIENT_COMPATIBILITY_MATRIX.md) | Twelve client targets: transport, auth, configuration, and what is verified |
| [CLIENT_SETUP_GUIDES.md](docs/CLIENT_SETUP_GUIDES.md) | One setup guide per client, with copyable templates |
| [CLIENT_GAP_ANALYSIS.md](docs/CLIENT_GAP_ANALYSIS.md) | What already worked, what needed building, and what was deliberately not built |
| [PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md) | Requirements with status and evidence |
| [PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Current state, remaining risks, what the first deployment needs |
| [DECISION_LOG.md](docs/DECISION_LOG.md) | Twenty-three decisions with their reasons |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Two rules matter more than the rest: do
not claim a client or an edition works until it has been tested, and do not merge
upstream silently.

## Licence and attribution

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project is a derivative of
[`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) by Diego Najar,
pinned at commit `73b5ddcb92015d1359370ba2613090eef6af910c`. The original
copyright notice is retained in full, the repository keeps upstream's complete git
history, and `src/index.js` is upstream code with only a provenance header added.

Bludit itself is a separate project. This server talks to a Bludit site over its
HTTP API; it does not bundle or modify Bludit.
