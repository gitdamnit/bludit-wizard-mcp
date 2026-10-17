# Decision Log

<!--
Canonical document 2 of 3. Append-only.

Add a new record for every decision that would be expensive to reverse or that a
future contributor would otherwise re-litigate. Never edit or delete an existing
record: to change your mind, append a new record that supersedes the old one and
update the old record's Status line to `Superseded by D-NNNN`.
-->

## How to Use This Log

1. Copy the block below to the end of the `## Decisions` section.
2. Use the next free four-digit ID. IDs are never reused and never renumbered.
3. Date the record the day the decision was actually made (`YYYY-MM-DD`).
4. Record the alternatives you rejected and why. A decision without context is a
   rumour, not a record.
5. Never rewrite history. If a decision changes, append a superseding record.

Allowed statuses: `Proposed`, `Accepted`, `Superseded`, `Deprecated`, `Rejected`.

## Decisions

### D-0001 — Distribute a portable core with three transports; local stdio is primary

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** The project was built as a hosted multi-tenant service on Cloudflare
  Workers, and the pre-deployment review concluded that Workers Paid at $5/month is
  required (PBKDF2 exceeds the free tier's 10 ms CPU allowance; its 1,000 KV
  writes/day cannot carry OAuth grants). The maintainer has decided not to operate
  a paid shared MCP server for end users. The service must be distributable for
  users to run themselves, at no cost to the maintainer.
- **Alternatives Considered:** Continue as a hosted service on Workers Paid
  (rejected: a recurring cost and an operational burden the maintainer will not
  carry); port the service to the maintainer's existing Hostinger Premium plan
  (rejected: Premium has no Node.js runtime, and the PHP rewrite analysed in
  `docs/hosting/PHP_ADAPTATION_ANALYSIS.md` would be a second security-critical
  codebase with no shared tests); operate on Cloudflare Workers Free (rejected: two
  independent blockers, documented in `docs/ARCHITECTURE.md`).
- **Decision:** Restructure the project around a **Portable Bludit MCP Core** — the
  Bludit API client, the 19 tool definitions, validation and the safety controls —
  consumed by three transports: **A. local stdio** (primary distribution), **B.
  self-hosted Streamable HTTP** (optional, user-operated), and **C. Cloudflare**
  (existing, preserved, optional).
- **Rationale:** Local stdio has no hosting cost, no shared accounts, no OAuth
  server, no central database and no network exposure, because it runs on the user's
  own machine and talks to their own Bludit site. It is also the transport that
  almost every desktop and CLI MCP client already supports. The cost is that the
  hosted multi-tenant features — per-client grants, the pairing flow, cross-account
  isolation — have no role locally and must not be carried over.
- **Consequences:** The tool layer becomes the shared surface and must be provably
  identical across transports. The Cloudflare implementation is retained as an
  optional adapter, so its tests must keep passing. New work is measured against
  "does this belong in the core, or in one transport?" Remote HTTP is designed but
  not implemented pending approval.
- **Supersedes:** None

### D-0002 — The Cloudflare implementation is preserved, not rewritten

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** Decision D-0001 changes the default distribution, which invites a
  temptation to simplify by deleting the hosted path. That path holds working,
  tested implementations of OAuth 2.1, tenancy isolation, credential encryption and
  the pairing flow, guarded by 428 tests.
- **Alternatives Considered:** Delete the Cloudflare adapter to reduce maintenance
  (rejected: destroys working security-critical code and its test coverage, and the
  hosted option may be needed later); leave it entirely untouched and build stdio
  beside it with duplicated tool definitions (rejected: two copies of 19 tools
  would drift, which is the failure this restructure exists to prevent).
- **Decision:** Keep the Cloudflare Workers, its configuration, its deployment
  documentation and its tests. Extract the shared core so both transports call the
  same tool definitions. Touch the Cloudflare code only where the extraction
  requires it, and prove no behaviour changed by keeping all existing tests green.
- **Rationale:** The tests are the project's only evidence that the safety controls
  hold. Deleting the adapter would delete that evidence for the parts that remain
  shared.
- **Consequences:** The extraction must be behavioural-change-free for the hosted
  path; the existing hermetic suite is the regression gate. Any transport-specific
  behaviour belongs behind a port, not in an `if`.
- **Supersedes:** None

### D-0003 — Local stdio uses a configuration trust model, not OAuth

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** The hosted service needs an authorization server because it acts for
  many users on many sites over a network. A local stdio process acts for one user,
  on a site that user configured, on that user's own machine.
- **Alternatives Considered:** Port the OAuth service into stdio (rejected: an
  authorization server protecting a process that already runs with the user's
  privileges adds attack surface and no security); a personal access token
  (rejected: still a bearer credential, now stored twice); no configuration at all
  (rejected: the tools need a site URL and credentials).
- **Decision:** Local stdio takes the Bludit URL, API token and auth token from
  environment variables or a protected configuration file. There is no account, no
  client registration, no grant, no token issuance and no network listener. Tool
  authorization is not enforced, because there is no principal to enforce it
  against: the process owner is the only actor.
- **Rationale:** The threat model is a single user acting on their own site. Adding
  an identity layer to that would be ceremony, not security. What *does* transfer
  is every control that protects the user's data and the integrity of their site:
  URL validation, credential redaction, no-delete, and review-before-write.
- **Consequences:** The scope checks that guard the hosted path become vacuous
  locally and must be documented as such rather than silently removed. Credentials
  live on the user's disk, which must be stated plainly in the setup guide: a local
  process is not a sandbox, and secrets on disk are as safe as the filesystem.
- **Supersedes:** None

### D-0004 — Local proposals are held in memory, not in a database

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** `apply_approved_edit` refuses to write unless a prior
  `propose_page_edit` exists, unexpired and pinned to the current page revision.
  Hosted, proposals live in D1. Locally there is no database, and D-0001 forbids
  requiring one.
- **Alternatives Considered:** Drop the proposal workflow locally (rejected: it is
  the review-before-write control and the task lists it as a security requirement);
  write proposals to a JSON file beside the config (rejected: introduces a second
  on-disk artefact holding page content and revision data, for no gain); require
  SQLite (rejected: a dependency and a file the user must manage).
- **Decision:** Hold proposals in an in-memory store with the same TTL and the same
  revision-pin semantics as the hosted store.
- **Rationale:** The workflow's value is that a human sees the change before it is
  applied. Within one agent session, in-memory storage delivers that exactly. The
  cost is honest and small: a proposal does not survive a process restart.
- **Consequences:** The stdio server's instructions and the tool's description must
  say that proposals are process-local, and a restart means re-proposing. The store
  sits behind the same `ProposalStore` port as the D1 implementation, so the
  behaviour under test is the same code path in both.
- **Supersedes:** None

### D-0005 — No-delete and review-before-write are core invariants, enforced in one place

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** These two controls are the reason the project takes no destructive
  action on a user's site. With three transports, each could in principle implement
  its own version, and one of them would eventually get it wrong.
- **Alternatives Considered:** Per-transport safety policy (rejected: three
  implementations of one invariant, and the weakest one sets the guarantee);
  document the invariant without enforcing it (rejected: a comment is not a
  control).
- **Decision:** No tool performs deletion — there is no delete tool to remove — and
  the approval gate lives in the shared tool layer, in `apply_approved_edit`, not in
  a transport. Tests assert both for every transport, including negative tests that
  a write without `confirm: true` is refused and that the tool list never contains a
  deletion tool.
- **Rationale:** An invariant enforced once, where all transports meet, is the only
  version that can be tested once and relied on everywhere.
- **Consequences:** A transport cannot opt out of the approval gate. A future
  request to expose deletion would require a new recorded decision, not a code
  change, and would still have to satisfy the core's tests.
- **Supersedes:** None

### D-0006 — SSRF protection is layered, and its limits are stated per transport

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** The hosted path has four SSRF layers, and the strongest is the
  Cloudflare platform flag `global_fetch_strictly_public`, which makes the runtime
  itself refuse private addresses. That layer is a platform feature: it does not
  exist in local Node, in Docker, or on any generic host. Layer one also happens to
  be the only layer that covers DNS rebinding.
- **Alternatives Considered:** Claim the static URL policy is sufficient (rejected:
  it checks the hostname, not the resolved address, and would be a false claim);
  implement a DNS-resolving guard and call the problem solved (rejected: a lookup
  followed by a connection is still two steps, so rebinding is narrowed, not
  eliminated); refuse to offer any transport without the platform flag (rejected:
  that would make local distribution impossible and is not proportionate to a
  single-user process acting on their own site).
- **Decision:** Keep the URL policy, redirect revalidation and response bounds in
  the core, where all transports get them. Document, per transport, which layer is
  missing: the platform layer is absent locally. Do not describe an
  application-level check as eliminating DNS rebinding.
- **Rationale:** Security claims must match what is actually deployed. A user
  running stdio against their own Bludit site faces a different threat model from a
  shared service fetching URLs supplied by strangers, and the documentation should
  say which controls apply rather than implying uniformity.
- **Consequences:** `docs/SECURITY.md` must state the per-transport posture. A
  DNS-aware guard is a candidate for the self-hosted HTTP adapter, where the input
  is genuinely untrusted, rather than for local stdio where it is not.
- **Supersedes:** None

### D-0007 — The local edition is compiled to ESM with `tsc`, not bundled

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** A distributable local edition needs runnable JavaScript, and the
  repository's default `tsconfig.json` is `noEmit` because wrangler bundles the
  Worker. Three options existed: bundle with esbuild, emit with `tsc`, or require a
  TypeScript-aware runtime (`tsx`, `--experimental-strip-types`) so the sources run
  directly.
- **Alternatives Considered:** Runtime type-stripping (rejected: it raises the
  minimum Node version and depends on a flag whose semantics are still changing);
  bundling with esbuild (rejected: a new build-time dependency and an opaque single
  file, when the point of a self-hosted edition is that a user can read what they are
  running); shipping no build at all (rejected: `npx` must work from a published
  package, and npm does not run `.ts` from a `bin` entry).
- **Decision:** Compile with `tsc -p tsconfig.local-build.json` to `dist/` as ESM
  (`module: NodeNext`, so the existing explicit `.js` import specifiers resolve under
  Node's real ESM loader). The `bin` entry points at `dist/local/index.js`; `prepack`
  builds it, so the published tarball always contains a fresh build.
- **Rationale:** No new dependency, a one-to-one output tree that mirrors the source,
  and the emitted JavaScript stays readable — which matters when the person running
  it is also the person auditing it. Measured: 49 files, 76.6 kB packed.
- **Consequences:** `dist/` is gitignored, so a git clone needs `npm run build:local`
  before `node dist/local/index.js` will work; `npx` from a published tarball does
  not, because `prepack` has already run. Changing either of these later means
  revisiting `files`, `bin` and `prepack` together.
- **Supersedes:** None

### D-0008 — `package.json` stays `private: true` until publication is authorised

- **Date:** 2026-10-16
- **Status:** Accepted
- **Context:** The migration's distribution goal includes npm, and the packaging is
  ready: `bin`, `files`, `prepack` and a verified clean install. But the instruction
  for this phase is explicit that nothing may be published.
- **Alternatives Considered:** Set `private: false` now, so the package is
  publication-ready (rejected: it converts a deliberate step into a single
  accidental `npm publish`, and an npm publication is effectively irreversible —
  unpublishing is restricted and the version number is burned); leave packaging
  incomplete (rejected: "ready but not published" should be verifiable, and it is —
  `npm pack` and a clean install are both exercised).
- **Decision:** Keep `private: true`. Prepare and verify everything publication needs;
  flipping that one field is the explicit act that precedes a release.
- **Rationale:** The failure mode of a premature publish is worse than the cost of
  one deliberate edit, and a build that has been packed and installed in a clean
  directory is already evidence that publication would work.
- **Consequences:** A future release must change `private`, and should do so in a
  commit whose only purpose is that change, alongside the `PROJECT_STATUS.md`
  release-status update.
- **Supersedes:** None
