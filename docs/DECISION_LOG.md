# Decision log

Architecture and product decisions in the order they were made, with the reason
and the consequence. Superseded decisions are kept, not deleted, because the
reasons they were replaced are themselves information.

Format: **context → decision → consequence**, plus alternatives considered where
the choice was close.

---

## ADR-001 — Build a derivative, preserve upstream, never merge silently

**Context.** `bludit/bludit-mcp` is a small MIT-licensed stdio server (one 200-line
file, no tests, six tools). The brief is to publish a hosted universal remote MCP
server, and to preserve attribution.

**Decision.** Clone upstream, pin it at `73b5ddcb92015d1359370ba2613090eef6af910c`,
keep the full git history, retain `src/index.js` verbatim with only a provenance
header, keep the MIT notice and add a derivative copyright line, and record the
workflow for tracking upstream in `UPSTREAM_COMPARISON.md`.

**Consequence.** Two servers live in one repository. Existing stdio users are not
broken. Any future upstream change is a reviewed commit with its own decision
entry, not a merge — a wholesale merge would reintroduce `delete_page` and the
startup-fetch behaviour that were removed deliberately.

**Alternatives considered.** A fresh repository with an attribution note (loses
commit-level provenance); rewriting the stdio server in TypeScript (breaks
upstream users for no gain).

---

## ADR-002 — Cloudflare Workers, not a VPS or container host

**Context.** The server needs a public HTTPS endpoint, OAuth, and a small amount
of state. It must not require an always-on process.

**Decision.** Two Cloudflare Workers, D1 for relational state, KV for the OAuth
provider's grants and tokens. No Docker in production, no VPS, no always-on
Linux process.

**Consequence.** ~$5/month, no patching, automatic TLS, global distribution.
The service inherits Cloudflare's platform limits, which are documented and
accounted for. A local Docker image exists **only** for live Bludit testing.

**Alternatives considered.** A small VPS (more cost, standby maintenance, no
benefit); Fly.io/Render (same shape as Workers but with a container to keep
alive); Deno Deploy (fine, but the OAuth provider library targets Workers).

---

## ADR-003 — Split the authorization server and the resource server

**Context.** The brief asks whether separate Workers improve security and
maintainability. The OAuth provider library supports both a combined and a split
shape.

**Decision.** Split. `bludit-wizard-auth` owns discovery, token issuance, consent,
accounts and the site UI; `bludit-wizard-mcp` owns the MCP endpoint and the CMS
client. They talk over one private Service Binding method, `validateToken`.

**Consequence.** A cross-tenant bug in tool handling cannot mint a token, and a
bug in consent cannot read a page — the two roles have different exposure and
different secrets. Cost is unchanged: Service Bindings do not incur extra request
fees on Standard pricing. The cost is two deployments to keep in step and a
shared D1 database, which is a real coupling.

**Alternatives considered.** One Worker (simpler to deploy, one trust boundary
for token issuance and content access); a third Worker for the CMS client
(more isolation than the threat model justifies).

---

## ADR-004 — Use `@cloudflare/workers-oauth-provider` rather than hand-rolled OAuth

**Context.** OAuth 2.1 for MCP means discovery, PKCE, refresh, revocation, DCR and
CIMD, plus the storage and rotation semantics that make them safe.

**Decision.** Use the officially supported provider library (1.2.3), with CIMD
enabled and DCR as a fallback.

**Consequence.** Far less security-critical code to get wrong, and standards
compliance (RFC 6749/6751/7009/7591/7636/8414/8707/9207/9728) comes with it. In
exchange, the library's behaviour is a dependency: it requires
`global_fetch_strictly_public` for CIMD, and that flag conflicts with reaching a
loopback site during tests. That constraint is documented and worked around with a
second test profile rather than by disabling the flag.

**Alternatives considered.** Hand-rolled OAuth (unacceptable risk for the
credential-minting path); a managed identity provider (adds a vendor and does not
solve MCP resource metadata).

---

## ADR-005 — Stateless Streamable HTTP, one server instance per request

**Context.** MCP supports stateful sessions over Streamable HTTP, which on Workers
means Durable Objects.

**Decision.** Stateless: `sessionIdGenerator: undefined`, a fresh `McpServer` per
request, no session store.

**Consequence.** No cross-tenant state can leak because none is retained, and
there is no Durable Object to pay for or reason about. A client that requires an
`Mcp-Session-Id` will not work; none of the target clients is documented to
require one, and that is stated as an unverified risk in
`CLIENT_COMPATIBILITY.md`.

**Alternatives considered.** Stateful sessions on Durable Objects (needed only
for server-initiated notifications, which this server does not send).

---

## ADR-006 — Page deletion is not exposed by any tool

**Context.** Upstream exposes `delete_page`. Bludit has no soft delete: the API's
`DELETE` removes the page directory and its database row.

**Decision.** No MCP tool deletes a page. A test asserts the tool list never
contains one.

**Consequence.** A plausible instruction like "clean up the drafts" cannot destroy
content, and deletion stays where a human can see what is being removed. The
capability is still available in the Bludit admin, the official API and the PHP
Wizard API; this server simply does not exercise it.

**Reconsideration criteria.** A recoverable delete (a trash key the CMS can
restore), a separate scope never granted by default, a per-call confirmation
carrying the page revision, and a documented review.

**Alternatives considered.** Expose it behind a scope (the scope would be granted
by default, which defeats the point); expose it with a confirmation flag (the
flag would be set by the same agent doing the deleting).

---

## ADR-007 — Site credentials encrypted with AES-256-GCM and the site id as AAD

**Context.** The service holds Bludit API tokens and user auth tokens: full write
access to a customer's website.

**Decision.** Encrypt with AES-256-GCM, key from the `SITE_CREDENTIAL_KEY` Worker
secret, fresh 96-bit IV per value, site id as additional authenticated data.
Decrypt for one outbound call, then discard.

**Consequence.** A database leak yields no usable credential, and a ciphertext
lifted from one row cannot be decrypted as another. The same token on two sites
produces different ciphertext, which a test asserts. Losing the key means
reconnecting every site, so it must be backed up outside Cloudflare.

**Alternatives considered.** Plaintext plus strict access control (a leak is then
total); hashing (impossible — the credential must be usable); Cloudflare Secrets
Store (a natural future move; not needed at this scale).

---

## ADR-008 — Connecting a site requires proof of control, not just a token

**Context.** A user pastes an API token. Nothing distinguishes a site they own
from one they merely have a token for, and a wrong-site write is the most damaging
failure this service could have.

**Decision.** Three independent requirements: a signed-in account, a single-use
pairing challenge generated by that account and stored only as an HMAC, and
site-side proof that the site received the challenge — either an HMAC proof from
the Bludit Wizard extension or the challenge published at
`/.well-known/bludit-wizard-challenge.txt`. The challenge is consumed last, so a
failed store leaves it usable.

**Consequence.** Claiming someone else's site requires writing to their filesystem
or holding their plugin key. The Wizard contract is *proposed*, not implemented in
PHP, so today the well-known file is the plugin-free path.

**Alternatives considered.** Token-only (no ownership proof); DNS TXT record (a
second system to explain, and the well-known file is simpler); OAuth against the
Bludit site (Bludit has no OAuth server).

---

## ADR-009 — Proposals with a revision pin, rather than a confirmation flag

**Context.** An agent that reads a page, thinks, and writes can clobber an edit
made in between. A `confirm: true` flag does not prevent that — the same
conversation sets it.

**Decision.** `propose_page_edit` records a short-lived, immutable,
account-and-site-bound proposal pinned to the page's current revision.
`apply_approved_edit` re-reads the page and refuses if the revision moved. The
proposal is claimed before the write, and the claim is released if the write
fails.

**Consequence.** A reviewed change cannot silently overwrite newer work, and two
concurrent applies cannot both proceed. The revision is derived from the page
payload, because Bludit's API exposes neither `dateModified` nor `md5file`.

**Alternatives considered.** ETag/If-Match (Bludit's API has no such header);
locking (no lock service, and a stale lock is worse than a stale proposal).

---

## ADR-010 — No inference in the server; deterministic tools only

**Context.** An AI-assisted CMS server could reasonably summarise, draft or embed.

**Decision.** No model calls, no provider key, no content store. `search_pages`,
`get_content_summary` and `get_related_pages` are deterministic and say so in
their descriptions.

**Consequence.** The operator pays no inference cost, no page content leaves the
system beyond the tool result the user asked for, and every result is
reproducible. The client's own model does the reasoning, which is where it belongs
and where the user already has a provider relationship.

**Alternatives considered.** Server-side summarisation (a cost and privacy change
with no capability the client lacks); embeddings (a store and a bill).

---

## ADR-011 — Rate limiting in D1, not KV and not in memory

**Context.** Rate limiting was the one accepted risk that genuinely blocked a
public deployment.

**Decision.** Fixed-window counters in D1, keyed by `category:HMAC(secret,
identifiers)`. Fail open on storage error, with a log line.

**Consequence.** One row read and one write per limited request, which is visible
in D1 usage and quantified in `ARCHITECTURE.md`. In exchange, the limit is global
and atomic rather than per-colo, and it is exercisable from the test harness.
No IP address or email address is stored, only an HMAC.

**Alternatives considered.** Workers KV (one write per second per key, eventually
consistent — it would under-count when it matters); in-memory (per isolate, so not
a limit); Cloudflare's Rate Limiting binding (cheaper and per-colo, but not
reachable from the test harness, so it is documented as an optional extra layer
rather than the mechanism).

---

## ADR-012 — Server-rendered HTML for the account UI, no SPA

**Context.** The account UI needs sign-in, consent, and site management. It is
used rarely and holds the most sensitive form in the system.

**Decision.** Server-rendered HTML from Hono, with a strict Content-Security-Policy
and no client-side framework. One small `confirm()` dialog is the only script.

**Consequence.** No CORS surface, no token in browser storage, nothing to build,
and the CSRF model is a plain form post. The UI is plain; that is an accepted
cost for a page visited a handful of times per user.

**Alternatives considered.** A React SPA (a build pipeline, a bundle, and a token
in the browser for no benefit); Cloudflare Access (a second identity system in
front of the first).

---

## ADR-013 — Mock-first testing, with live tests as the arbiter

**Context.** The default suite must run anywhere, with no network, credentials or
Docker. But a mock only proves the server agrees with itself.

**Decision.** Two suites. A hermetic suite (324 tests) against a hand-written mock
of the Bludit 3.22.x API, and an opt-in live suite (24 tests) against real Bludit
Community and Pro in containers. The mock must be made faithful to whatever the
live run discovers.

**Consequence.** This decision has already paid for itself three times: the first
live run found that `tags` is a comma-joined string (the mock said array, and the
server crashed on the real one), that `category` is `false` when a page has no
configured category, and that only published/static/sticky pages are tag-indexed.
All three are now fixed and the mock reproduces them exactly.

**Rule derived from it.** A mock disagreeing with a live site is a mock defect
first and a server defect second. Fix both, and record the finding.

**Alternatives considered.** Live-only testing (unrunnable in CI, slow, needs
credentials); mock-only testing (what the first version had, and it hid a crash).

---

## ADR-014 — One hostname for the issuer and the resource, for v1

**Context.** `AUTH_ISSUER` and `MCP_RESOURCE` may share an origin or not.

**Decision.** Share one origin for the first deployment. Both variables must match
in both configs, which a test asserts.

**Consequence.** One certificate, one DNS record, one consent page reachable at
the same host as the MCP endpoint. Splitting later is a configuration change plus
a resource-metadata change, not a redesign; the split-Worker topology already
supports it.

**Alternatives considered.** Separate `auth.` and `mcp.` hostnames (cleaner
separation, two DNS changes before anything works).

---

## ADR-015 — Five scopes, with a baseline read pair

**Context.** Scope granularity trades off consent simplicity against
least-privilege.

**Decision.** `sites:read`, `pages:read`, `pages:write`, `settings:read`,
`offline_access`. The resource advertises `sites:read pages:read` as what any
access requires; a `403` challenge names the **complete** set an operation needs,
including the baseline.

**Consequence.** A client that asks for `pages:write` alone still gets told to ask
for the read scopes, which prevents the common step-up bug where a client requests
only the missing scope and is refused again. The consent page lets a user decline
write access.

**Alternatives considered.** One `mcp` scope (no least privilege); a scope per
tool (a consent page nobody reads).

---

## ADR-016 — Cloudflare Workers Paid is the minimum viable plan

**Context.** Could this run on the free tier?

**Decision.** No. Document $5/month as the realistic minimum.

**Consequence.** The reason is specific and recorded in `ARCHITECTURE.md`:
PBKDF2-SHA256 password hashing is deliberately expensive and exceeds the free
tier's 10 ms CPU allowance, and the free tier's 1,000 KV writes per day cannot
carry OAuth grants and refreshes. Lowering the iteration count to fit would trade
credential security for $5/month, which is a bad trade.

**Alternatives considered.** A weaker KDF (rejected above); moving accounts off
password auth to an external IdP (a new dependency and a new approval).

---

## ADR-017 — Pin workaround: `legacy-peer-deps` and TypeScript 5.9

**Context.** `npm install` crashes on npm 10.9.8 with an arborist
`Cannot read properties of null (reading 'edgesOut')` error while resolving
vitest's peer set. TypeScript 7.0.2 is current.

**Decision.** Set `legacy-peer-deps=true` in `.npmrc` with the reason recorded
inline and in `DEPLOYMENT.md`. Pin TypeScript to 5.9.3.

**Consequence.** Installs work today and a reviewer can remove the flag once a
newer npm is in use. TypeScript 7 is deliberately deferred because the Cloudflare
type packages and Wrangler 4 are exercised against the 5.x line; moving should be
its own change.

**Alternatives considered.** pnpm (works, but changes the documented workflow for
every contributor to work around one npm bug); `--force` (hides the problem).

---

## ADR-018 — Two test profiles, because the production flag and loopback conflict

**Context.** `global_fetch_strictly_public` is required for CIMD and is the
platform layer of the SSRF defence. It also blocks the loopback mock Bludit server.

**Decision.** A `runtime` profile without the flag (for CMS tool tests) and a
`production-shape` profile with it (for discovery, authorization and SSRF tests).

**Consequence.** Both configurations are genuinely exercised. A test documents
that Miniflare does not enforce the flag locally, so the platform layer is
verified by configuration and by post-deployment checks, not by the local suite —
recorded as a limitation rather than glossed over.

**Alternatives considered.** One profile with the flag off (would mean never
testing the production configuration); one profile with the flag on (would mean
never testing the CMS tools).

---

## ADR-019 — Document accepted risks rather than hiding them

**Context.** Every project has residual risk. The question is whether it is
written down.

**Decision.** `SECURITY.md` lists every accepted risk with its reasoning and
prioritised remaining work, and the test report lists what is *not* covered.
Coverage is reported with the caveat that makes it meaningful rather than as a
headline percentage.

**Consequence.** A reviewer can see exactly what is known and what is not, which
is more useful than a claim of completeness — and it forced rate limiting to be
implemented rather than left as a footnote, because it was written down as a
blocker.

---

## ADR-020 — Personal access tokens, for the clients that cannot do OAuth

**Context.** The client-compatibility requirement names twelve environments.
Official documentation shows that at least four resolved surfaces cannot present
an OAuth token: GitHub Copilot's cloud agent and code review ("do not currently
support remote MCP servers that leverage OAuth for authentication and
authorization"), Mistral's Vibe Code CLI ("does not yet support MCP servers that
require OAuth authentication"), Empryo (static headers only), and JetBrains AI
Assistant (remote authentication undocumented). Against an OAuth-only server they
cannot connect at all — not to this server, and not to any conforming remote MCP
server that requires authentication.

**Decision.** Add a personal access token: a user-created, labelled, scoped,
expiring, immediately-revocable bearer credential owned by one account.

**Consequence.** Those four surfaces become reachable, which they were not before.
The cost is real and is stated rather than buried: a token is a long-lived bearer
credential that a user will paste into a client configuration file. Four things
bound the damage — the scopes are chosen by the user, expiry is enforced on every
request, revocation takes effect on the very next request (better than the OAuth KV
path, which can lag), and the audit log records `pat:<id>` so a specific token can
be identified and revoked. A token cannot delete a page, because no tool can, and
it passes through the same review-before-write gate.

The alternative was to leave four named targets unserviceable. That would have met
the letter of the requirement while failing its purpose.

**Reconsideration criteria.** If every target client gains OAuth support, remove
the feature. It exists to serve clients, not as a permanent credential type.

**Alternatives considered.** Rejecting the requirement for those clients (fails the
requirement); a shared per-site API key (worse: not per-user, not revocable per
person, no scope); proxying through a vendor-hosted credential (a new external
service and a new approval).

---

## ADR-021 — Tolerate a non-conformant `Accept` header

**Context.** The MCP Streamable HTTP specification requires a client to send
`Accept: application/json, text/event-stream` on POST. The SDK transport enforces
it, so anything else — `application/json`, `text/event-stream`, or `*` — returned
`406 Not Acceptable`. Measured on this server before the change and recorded in
`test/integration/protocol-surface.test.ts`.

**Decision.** Normalise the header in the resource server before the transport sees
it: `withTolerantAccept()` ensures both content types are offered.

**Consequence.** Four header shapes now work instead of one. The behaviour is
strictly more permissive — nothing that worked before stops working — and the
response is still a single JSON body, so a client that understands *only*
server-sent events is still not served. That residual is documented rather than
implied away.

A stricter reading would be to refuse and tell the user their client is
non-conformant. That is defensible, but a `406` is an opaque failure that looks
like a server bug, and the compatibility goal is reachable for the cost of a
fifteen-line adapter.

**Alternatives considered.** Leaving the `406` (simplest, worst experience);
switching to SSE responses (changes the response contract for everyone).

---

## ADR-022 — One server, no stdio bridge, no per-client backends

**Context.** Twelve target clients could plausibly be served by twelve
integrations, or by a bridge for clients that only speak stdio.

**Decision.** Serve every client from the one remote Streamable HTTP server and the
one authorization service. Build no stdio bridge. Build no per-client backend.

**Consequence.** The research justifies this rather than the preference: every
remote surface among the twelve documents native remote MCP support, or a native
connector (Claude Desktop), so a bridge would be new code with no client to serve.
The single stdio-only surface, the Junie IDE plugin, fails for a different reason —
it documents no token support at all — and a bridge would not fix it.

The cost is that clients which fall back to legacy SSE get a JSON response rather
than a stream. Four clients support SSE as a fallback; all four prefer Streamable
HTTP, and one (Gemini Enterprise) refuses SSE outright.

**Alternatives considered.** A stdio bridge (no client needs it); per-client
adapters (rejected by the requirement itself, and twelve code paths to keep
secure); a legacy `/sse` endpoint (deprecated in the specification, and one target
refuses it).

---

## ADR-023 — Native Bludit Wizard PHP remains a first-class independent product

**Context.** A binding requirement states that the native PHP plugin must keep
working inside Bludit with configurable OpenAI-compatible providers, without MCP,
Cloudflare, or any particular AI vendor.

**Decision.** Reaffirm and hold the existing position: the PHP plugin is not
modified, is not a dependency of this server, and this server is not a dependency
of it. It runs its own inference with the user's own provider key; this server runs
no inference. The only relationship is optional and one-directional — when the
plugin is present, this server can use its pairing endpoint and report it as a
capability.

**Consequence.** A Bludit user can adopt the plugin, this server, both, or neither,
and nothing breaks. The hosted server works through the official Bludit API alone,
so the plugin is never required. Where this server would benefit from an interface
the plugin does not expose, the contract is proposed in
`PHP_WIZARD_INTEGRATION.md` rather than invented in PHP code.

This was already the design; it is recorded here as an explicit decision because
the client-compatibility requirement restates it, and a decision that is only
implicit is one that gets eroded by the next change.

**Alternatives considered.** Making the plugin a prerequisite for Wizard tools
(couples the products and contradicts the requirement); shipping inference in the
hosted server (a cost, a privacy change, and a second provider relationship for the
user).

---

## ADR-024 — What is rate limited, and what deliberately is not

**Context.** The pre-deployment review found four expensive or sensitive endpoints
entirely unprotected: `POST /signup`, `POST /tokens`, `POST /authorize/decision` and
`POST /sites/:id/check`. `POST /signup` is reachable with no credential, runs
PBKDF2, and writes a row — a CPU and storage abuse vector. `POST /sites/:id/check`
makes four or five outbound requests to the customer's own site, which makes it an
amplifier pointed at them. The MCP limit was also per client only, so an account
with twenty authorized clients got twenty separate budgets against the same CMS.

**Decision.** Add five buckets: `signup` (per address), `pat_create`, `consent` and
`site_check` (per account), and `mcp_account` (per account, aggregate across every
authorized client). Leave revocation, sign-out, the health check, the public
metadata documents and all read-only form renders unbounded.

**Consequence.** Every mutating or expensive endpoint is now bounded, and the
aggregate MCP bucket means many clients cannot together exceed what one account
should place on a customer's site. The refusals are narrow: five accounts an hour
from one address, thirty tokens an hour, sixty capability checks an hour.

The part that matters as much as what was added is what was **not**. A rate limit on
revocation would be actively harmful: the moment a user discovers a leaked token is
the moment they must be able to kill it, and a limiter that stalls them trades a
theoretical abuse for a real incident. The same reasoning applies to sign-out, and a
limit on the health check would make monitoring report an outage it caused. A test
asserts that ten consecutive revocations are all accepted, so this cannot regress.

**Alternatives considered.** Lowering the PBKDF2 iteration count to make signup cheap
enough not to need a limit (weakens password storage for everyone); a CAPTCHA
(a third-party dependency and a new approval, for a service with a handful of
users); limiting every endpoint uniformly (protection theatre, and it would have
caught revocation).
