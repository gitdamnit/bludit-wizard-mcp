# Reuse audit: from one hosted transport to a portable core

This is the record of what was reused, what was extracted, what changed and what
was deliberately left alone when the project went from a single hosted transport to
a portable core with three. It was written **before** the code was written, as a
precondition for changing anything.

The conclusion, stated first: the code was already almost portable, and the
extraction is small — three ports and about a dozen call sites. No tool was
rewritten. That is worth saying plainly, because the alternative reading ("rewrite
the server for stdio") would have duplicated nineteen tools and their safety rules,
which is precisely the failure this restructure exists to prevent.

---

## 1. What existed before

Two things lived side by side in this repository, and both are still here.

### 1.1 Upstream's stdio server — `src/index.js`

216 lines, kept verbatim from
[`bludit/bludit-mcp`](https://github.com/bludit/bludit-mcp) (MIT, © 2026 Diego
Najar) with only a provenance header added. It is a working, standards-compliant
stdio MCP server for one site.

It has exactly three characteristics that mattered for this work:

1. **It already reads the configuration we want.** `BLUDIT_URL`,
   `BLUDIT_API_TOKEN`, `BLUDIT_AUTH_TOKEN` — the same three names, from the
   environment. The new local edition keeps them, so an existing upstream stdio user
   can switch without relearning anything.
2. **It is a single-file, single-site implementation.** No registry, no tenancy, no
   OAuth. Good as precedent; not reusable as a core, because it has no tool
   registry, no validation layer and no safety controls to share.
3. **It is the thing upstream users depend on.** Deleted files cannot be depended
   on, so it stays.

**Reused:** the configuration contract, and the proof that "one site from the
environment" is a shape upstream already validated.

### 1.2 This project's hosted server — `src/mcp/`, `src/auth/`

The project's own work: OAuth 2.1 (PKCE, DCR, CIMD, refresh, revocation), personal
access tokens, account and site management, per-account tenancy isolation,
encrypted credential storage, the proposal/approval workflow, capability detection,
the SSRF policy, rate limiting and the nineteen tools. 5,000 lines of source and
428 tests.

The question was never whether to reuse this. It was **what the seam is**.

---

## 2. Dependency map

Where each capability actually lives, and therefore which parts of the tree a
transport-specific concern reaches into.

| Concern | Module | Depends on | Portable? |
|---|---|---|---|
| Bludit HTTP API client | `src/bludit/client.ts`, `types.ts` | `fetch`, `URL`, `crypto.subtle` | **Yes** — no Workers API |
| Capability detection | `src/bludit/capabilities.ts` | the client | **Yes** |
| Zod tool schemas | `src/mcp/tools/*.ts` | `zod` | **Yes** |
| Safety rules | `write-helpers.ts`, `proposals/diff.ts`, `validators` | pure functions | **Yes** |
| SSRF policy | `src/shared/ssrf.ts` | `URL`, `dns` is *not* used | **Yes** |
| Crypto helpers | `src/shared/crypto.ts` | `crypto.subtle` (WebCrypto, present in Node 20+) | **Yes** |
| Redaction / logging | `src/shared/log.ts` | `console` | **Yes**, with a redirect (see §4.3) |
| Tool registry | `src/mcp/server.ts`, `tools/index.ts` | the SDK | **Yes** |
| **Site lookup** | `src/mcp/tools/context.ts` → `src/sites/registry.ts` | **D1**, `SITE_CREDENTIAL_KEY` | **No** — extracted behind a port |
| **Audit log** | `src/mcp/tools/context.ts` → `src/audit/log.ts` | **D1** | **No** — extracted behind a port |
| **Proposals** | `src/mcp/tools/write.ts` → `src/proposals/store.ts` | **D1** | **No** — extracted behind a port |
| OAuth authorization server | `src/auth/*` | Workers, KV, Service Bindings, Hono, WebCrypto, `@cloudflare/workers-oauth-provider` | **No** — and not wanted |
| Account & site UI | `src/auth/*` | Hono, D1 | **No** — and not wanted |
| Rate limiting | `src/shared/rate-limit.ts` | **D1** | Hosted-only (see §6) |

Imports of Cloudflare-only packages, by file — the complete list:

```
src/auth/app.ts          src/auth/consent.ts      src/auth/index.ts
src/auth/oauth.ts        src/auth/types.ts        src/mcp/app.ts
src/shared/env.ts
```

Seven files, all in the hosted path. **Every one of those imports in the local
runtime graph is type-only**, and TypeScript erases them. Measured on the built
artefact, following runtime `from '…'` specifiers from `dist/local/index.js`:

```
local modules loaded: 32
external packages:    @modelcontextprotocol/sdk, node:fs, node:url, zod
```

No Hono, no `@cloudflare/workers-oauth-provider`, no `@cfworker/json-schema`, no D1,
no Workers global. The local edition's runtime dependency graph is the MCP SDK, Zod
and the Node standard library. (The *installed* dependency set is larger, because
`package.json` declares the Cloudflare packages for the Worker build; see §7.)

---

## 3. The seam: three ports

The tools reach outward in exactly three places. Measured across the seven tool
modules before the change:

| Reach | Uses | Where |
|---|---|---|
| `siteFor(ctx, ref)` / `resolveSite(ctx, ref)` | 22 | every tool |
| `withAudit(ctx, tool, fn)` | 19 | every tool |
| `requireToolScope(ctx, tool)` | 20 | every tool |
| `ctx.db` directly | 9 | `context.ts` (4), `write.ts` (4), `sites.ts` (1) |
| `ctx.env` directly | 3 | `write.ts` |

The `ctx.db`/`ctx.env` reach was the whole problem — nine call sites — and it
clustered into three concerns:

- **Which site am I acting on** → `SiteSource`
- **Where does the proposal live** → `ProposalStore`
- **Where does the audit trail go** → `AuditSink`

`requireToolScope` needed nothing: it reads `ctx.scopes`, which is already supplied
by whoever built the context.

### 3.1 The interfaces describe rows, not domain objects

`ResolvedSite` keeps `resolved.row.id` and friends, because that is what the tool
bodies already read. Keeping the row shape meant the extraction touched the ports
and their call sites and left the tool bodies untouched.

This is a deliberate, unglamorous choice. A purer design would model `Site` as a
domain object and rewrite twenty call sites. It would also have been the change most
likely to alter behaviour subtly, for no gain.

### 3.2 What the diff actually was

| File | Change |
|---|---|
| `src/mcp/tools/ports.ts` | **new** — the three interfaces, 96 lines |
| `src/mcp/tools/d1-ports.ts` | **new** — the Cloudflare implementations, wrapping the existing D1 modules unchanged |
| `src/mcp/tools/context.ts` | rewritten — `ToolContext` carries ports; helpers delegate; `buildToolContext` keeps its **signature** |
| `src/mcp/tools/sites.ts` | 2 call sites: `ctx.db.prepare(…)` → `ctx.sites.list()`, `updateSiteCapabilities` → `ctx.sites.updateCapabilities` |
| `src/mcp/tools/write.ts` | 6 call sites: `createProposal`/`getProposal`/`markProposalApplied`/raw `UPDATE` → `ctx.proposals.*` |
| `src/mcp/server.ts` | one added optional parameter (`instructions`) |

**Unchanged:** `src/bludit/*`, `src/shared/*`, `src/proposals/diff.ts`,
`src/proposals/store.ts`, `src/sites/registry.ts`, `src/sites/registry-helpers.ts`,
`src/sites/credentials.ts`, `src/audit/log.ts`, `src/auth/*`, all of `wrangler.*`,
and **all nineteen tool bodies**.

Because `buildToolContext` kept its signature, `src/mcp/app.ts` did not change at
all — the hosted transport picked up the extraction without being touched.

### 3.3 Why not `if (isLocal)`

A boolean branch inside each tool would have been smaller today and worse
immediately after: nineteen places to get the local case wrong, and no way to test
that the hosted case still behaves. A port makes the transport substitutable and,
more usefully, makes "the tools do not know which transport they are in" a fact
that can be asserted.

---

## 4. What had to change for local stdio

### 4.1 The local context

`src/local/context.ts` builds a `ToolContext` with the same ports filled
differently. It grants every scope (see §5.2) and supplies synthetic `AuthProps`,
because `AuthProps` is just identity data and the tools only pass it around.

### 4.2 No credential encryption, because there is no credential store

The hosted transport encrypts site credentials with AES-256-GCM before writing them
to D1. Local credentials are read from configuration on each call and never
persisted by the process, so there is nothing to encrypt. The local `SiteRow` leaves
the `*_enc` columns empty, and every tool reads credentials from the port, never
from the row.

This is a real behavioural difference and it is intentional: porting the encryption
without porting the store it protects would mean holding a key with nothing to
protect, which is how key management becomes theatre.

### 4.3 stdout belongs to the protocol

`src/shared/log.ts` wrote `info`/`debug` to `console.log` — stdout. On Workers every
`console.*` call is captured the same way, so this was harmless there. Under stdio it
is fatal: one stray line desynchronises the JSON-RPC framing.

Rather than change what the hosted transport does, `log.ts` gained a swappable
diagnostic writer which still defaults to the console. The local entry calls
`writeDiagnosticsToStderr()` before anything can log. The audit sink writes to
stderr as well.

This is the one change made specifically because a *runtime* differs rather than
because a *capability* differs, and it is asserted at process level: the test suite
parses **every** line the spawned server writes to stdout as JSON-RPC.

### 4.4 Proposals in memory

The D1 proposal store is wrapped, not replaced: `memoryProposalStore` implements the
same semantics — immutable on creation, TTL, site-bound, revision-pinned, atomic
claim, release-on-failed-write — over a `Map`. The store's *policy* is unchanged
because `assertProposalApplicable` still runs in the tool, on both transports.

The honest cost, recorded as decision D-0004: a proposal does not survive a
restart. This is stated in the server instructions so a client can react to it
rather than report a bug.

---

## 5. How tool behaviour stays identical

### 5.1 The tool list is asserted against one shared constant

`TOOL_SCOPES` in `src/shared/scopes.ts` names the nineteen tools and the scope each
requires. Both suites assert their transport's `tools/list` equals `TOOL_NAMES`
derived from it:

- `test/integration/mcp-tools.test.ts` (hosted, over Streamable HTTP)
- `test/local/stdio-edition.test.ts` (local, over the MCP protocol)

Neither can drift from the registry without a test failing, and the hosted suite
cannot be used as evidence for stdio, or the reverse.

### 5.2 Scope enforcement: kept, and vacuous on purpose

`requireToolScope` is still called by every tool in both transports. Locally it can
never fail, because there is exactly one principal. It is kept for two reasons: the
same code path runs in both places, and removing it locally would create the one
difference in the tool bodies that the whole design exists to avoid.

### 5.3 What is genuinely untested offline

Tool *schema* identity is asserted. Behaviour equality is asserted only to the
extent the mocked Bludit semantics are faithful: the hosted suite and the local
suite both run against `test/harness/mock-bludit.ts`, which reproduces
`bl-plugins/api/plugin.php` (Bludit 3.22.x) and was itself corrected by live runs
against real Bludit Community and Pro. The local suite inherits that fidelity; it
does not prove anything about a live site, and nothing here should be read as if it
did. Live verification remains `npm run test:live`, which needs Docker.

---

## 6. What was deliberately *not* ported

| Not ported | Why |
|---|---|
| OAuth 2.1 authorization server | There is no second principal locally. An authorization server protecting a process that already runs with the user's privileges is attack surface, not security. |
| Account and site-management UI | No accounts. |
| KV, Service Bindings, Durable Objects | Nothing cross-request to store or coordinate. |
| Multi-tenant isolation | One tenant, by construction. |
| `src/shared/rate-limit.ts` | D1-backed. The local threat model has no anonymous traffic to rate-limit; the *request bounds* that matter (timeout, max response bytes) live in the Bludit client and are kept. Documented as a gap rather than silently dropped. |
| Credential encryption | §4.2. |
| The Cloudflare platform SSRF layer | Not available in Node. Documented per transport; not claimed. |

The rule applied throughout: port what protects **the user's site and data**; drop
what protects **the hosted service from its users**.

---

## 7. Attribution and licensing

- Upstream history is intact — 37 commits to `398b2f6 init` — and was not rewritten.
- `LICENSE` carries both copyright lines: Diego Najar (original) and Evan Zellner
  (this project).
- `NOTICE` records the upstream project, the pinned commit
  `73b5ddcb92015d1359370ba2613090eef6af910c`, and what is inherited.
- `src/index.js` keeps upstream's file, with a provenance header and no behavioural
  edit.
- The new local edition is **derived**, not copied: it reuses this project's own
  licensed code and the MCP SDK. It contains no upstream code beyond what was
  already in the tree.

---

## 8. Known follow-ups

1. **Dependency declaration is too broad for local installs.** A local install
   pulls 98 packages (~30 MB) because `package.json` declares Hono,
   `@cloudflare/workers-oauth-provider` and `@cfworker/json-schema` for the Worker
   build. The local *runtime* graph does not touch any of them (§2). Moving the
   Cloudflare-only packages to `optionalDependencies`, or splitting the published
   package, would cut the install by roughly two thirds. Not done in this phase
   because it touches the hosted build's dependency resolution, and the hosted path
   is under a do-not-change constraint.
2. **No real MCP client product has been verified** against the local edition. The
   MCP SDK's own client over a real stdio pipe is used, which exercises the
   protocol, but a client product's configuration and inspector behaviour is a
   separate question with a separate failure mode.
3. **`src/index.js` and the new local edition now overlap.** Upstream's server
   remains for existing users. A future decision should settle whether it is
   deprecated in favour of the new edition and on what timeline.
4. **A git-URL install would not build.** `prepack` covers `npm pack` and registry
   installs, which is how a published tarball is consumed, and that path is verified.
   But `npm install github:<owner>/<repo>` runs `prepare`, not `prepack`, so `dist/`
   would be absent and the `bin` entry would not resolve. Adding
   `"prepare": "npm run build:local"` fixes it. Not added in this phase because it
   changes what `npm install` does in every checkout, including CI, and that deserves
   its own verification rather than being slipped in at the end.
5. **No MCP client product has been verified** against the local edition — repeated
   from §7 because it is the largest remaining gap, and because "the SDK's client
   works over a real stdio pipe" is not the same claim.
