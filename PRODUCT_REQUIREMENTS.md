# Product Requirements

Canonical document 1 of 3. Requirements for the portable core and its three
transports. Detail for each area lives in the documents under `docs/`.

## Project Identity

**Bludit Wizard MCP** — an independent, MIT-licensed MCP server for
[Bludit CMS](https://www.bludit.com), distributed as a portable core with three
transports: local stdio (primary), self-hosted Streamable HTTP (optional), and a
preserved Cloudflare adapter (optional).

Derived from [`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp), pinned at
`73b5ddcb92015d1359370ba2613090eef6af910c`, MIT, © 2026 Diego Najar. Upstream
history and attribution are preserved; see `docs/UPSTREAM_COMPARISON.md`.

Maintainer: Evan Zellner. Working branch: `feat/local-stdio-edition`, a worktree of
`feat/remote-mcp-oauth-v1`.

## Purpose

Let a user drive their own Bludit website from any MCP-capable AI client — listing
pages, reading content, creating drafts, and applying reviewed edits — **without
anyone operating a paid shared service on their behalf, and without the server
running inference of its own.**

## Intended Users

1. **A Bludit site owner** who wants AI assistance editing their own site and is
   willing to run one command locally. This is the primary user.
2. **A Bludit site owner with a server** who wants the same capability reachable
   from a hosted client, and is willing to run their own Docker deployment.
3. **A developer or researcher** evaluating MCP, Bludit integration, or a
   multi-tenant authorization design.

Explicitly **not** the audience: anyone expecting the maintainer to host, operate,
pay for, or administer a shared MCP endpoint.

## Functional Requirements

### Portable core

| ID | Requirement | Status |
|---|---|---|
| FR-1 | One Bludit HTTP API client, used by every transport | Implemented |
| FR-2 | Nineteen tool definitions in a single registry, shared by every transport | Implemented |
| FR-3 | Identical tool names, schemas, descriptions and annotations across transports | Implemented |
| FR-4 | Input validation and structured, non-leaking error responses | Implemented |
| FR-5 | Site resolution and audit logging behind ports, so a transport supplies its own | Implemented |
| FR-6 | Proposals (review-before-write) behind a port with unchanged semantics | Implemented |

### Transport A — local stdio (primary)

| ID | Requirement | Status |
|---|---|---|
| FR-7 | Standards-compliant MCP stdio server, one process per installation | Implemented |
| FR-8 | Site URL and credentials from environment variables or a config file | Implemented |
| FR-9 | No account, no client registration, no token issuance, no network listener | Implemented |
| FR-10 | No database, local or remote | Implemented |
| FR-11 | Protocol messages only on stdout; diagnostics and audit on stderr | Implemented |
| FR-12 | Reliable, explicit errors for missing or invalid configuration | Implemented |
| FR-13 | Clean shutdown on transport close and on SIGINT/SIGTERM | Implemented |
| FR-14 | No secret value in stdout, stderr, or any MCP response | Implemented |
| FR-15 | No Cloudflare binding or environment required | Implemented |

### Transport B — self-hosted Streamable HTTP (optional, design only)

| ID | Requirement | Status |
|---|---|---|
| FR-16 | Design for user-operated deployment, including Docker Compose | Implemented as a design; not implemented in code |
| FR-17 | Authentication suitable for remote access | Designed |
| FR-18 | Persistent storage for sites and credentials | Designed |
| FR-19 | HTTPS and reverse-proxy guidance | Designed |
| FR-20 | No mandatory Cloudflare account and no mandatory paid host | Designed |

### Transport C — Cloudflare adapter (preserved)

| ID | Requirement | Status |
|---|---|---|
| FR-21 | OAuth 2.1 authorization server with PKCE, DCR, CIMD, refresh and revocation | Implemented, preserved |
| FR-22 | Personal access tokens for clients that cannot do OAuth | Implemented, preserved |
| FR-23 | Multi-tenant isolation by account, grant, scope and site | Implemented, preserved |
| FR-24 | Deployment documentation and safety controls retained | Implemented, preserved |
| FR-25 | Cloudflare-specific tests remain available and passing | Implemented, preserved |

### Safety invariants, all transports

| ID | Requirement | Status |
|---|---|---|
| FR-26 | No tool performs deletion, in any transport | Implemented |
| FR-27 | Modifying writes require a prior proposal and an explicit `confirm: true` | Implemented |
| FR-28 | Every write is verified by reading the page back | Implemented |
| FR-29 | Credential redaction in every log, error and tool response | Implemented |
| FR-30 | URL validation, reserved-range refusal, bounded redirects and response limits | Implemented |

## Nonfunctional Requirements

| ID | Requirement | Status |
|---|---|---|
| NFR-1 | Zero recurring cost to the maintainer | Met: no hosted service is operated |
| NFR-2 | Zero cost to a local user | Met: Node.js only, no account, no service |
| NFR-3 | No inference, no model provider key, no page-content store | Met |
| NFR-4 | Reproducible dependencies with exact pins | Met |
| NFR-5 | The default test suite needs no network, credentials or containers | Met |
| NFR-6 | Node.js 20+ and Windows, macOS, Linux | Met: Node 22 verified locally; other platforms not tested |
| NFR-7 | Honest documentation: no claim without evidence | Met by policy; see `CONTRIBUTING.md` |

## Scope and Exclusions

**In scope:** the portable core; the local stdio transport; a design for the
self-hosted HTTP transport; preservation of the Cloudflare adapter; test evidence
for all of the above.

**Out of scope, deliberately:** page deletion; image and file upload; editing site
settings; Bludit user administration; server-side inference; embeddings; billing,
subscriptions or licensing servers; and **operating any hosted endpoint for other
people**, which is the decision this restructure follows from.

## Technical Constraints

| Constraint | Consequence |
|---|---|
| The maintainer must not run a paid shared service | Local stdio is the primary distribution |
| Hostinger Premium has no Node.js runtime | Not a target; the PHP path is analysed but not chosen |
| Local execution has no platform-level SSRF layer | Per-transport security posture, documented in `docs/SECURITY.md` |
| A local process runs with the user's privileges | It is not a sandbox; the setup guide must say so |
| Proposals cannot be persisted without a database | In-memory with a TTL; a restart means re-proposing |
| The Cloudflare adapter must keep working | The extraction may not change hosted behaviour |

## Acceptance Criteria

1. The local stdio server starts from documented configuration and answers
   `initialize`, `tools/list` and `tools/call` over stdio.
2. All 19 tools are registered, with names, schemas and annotations identical to the
   hosted transport.
3. Reads, draft creation, and the propose → approve → apply → verify flow all work
   against a real Bludit HTTP API.
4. A write without `confirm: true` is refused, and no tool deletes a page.
5. Missing or invalid configuration produces an explicit error on stderr and a
   non-zero exit, never a silent partial start.
6. No credential appears in stdout, stderr or any tool response — asserted by test.
7. The hermetic suite that guards the Cloudflare adapter still passes unchanged.
8. `npm ci` and a clean install run the local server without any Cloudflare binding.

## Release Objectives

1. **Local stdio edition published for self-service installation** — GitHub Release
   and, if appropriate, npm. *Not published in this phase.*
2. **Self-hosted HTTP edition** — design approved before implementation.
3. **Cloudflare adapter retained as optional** — preserved, not promoted.
4. **Native Bludit Wizard PHP plugin** — a separate, independent product, not
   modified by this work.

## Evidence and Status Vocabulary

Work items use exactly one state: `Planned`, `In Progress`, `Implemented`, `Tested`,
`Deployed`, `Published`, `Blocked`, `Removed`. A state of `Implemented` or beyond
requires evidence on the same line: a backticked path, a commit SHA, or a URL.
`docs/PROJECT_STATUS.md` carries the current evidence and test results.
