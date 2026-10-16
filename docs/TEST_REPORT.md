# Test report

Measured output, not recollection. Every number below came from a run recorded in
this project.

## Run metadata

| | |
|---|---|
| Test date | 2026-10-16 |
| Test suite at | `83b2b92` and later documentation commits on the same branch |
| Branch | `feat/remote-mcp-oauth-v1` |
| Upstream pin | `73b5ddcb92015d1359370ba2613090eef6af910c` |
| Platform | Linux 7.0.0-38-generic |
| Node.js | 22.23.2 |
| npm | 10.9.8 |
| Docker | 29.9.1 (live Bludit installations only) |
| Runtime under test | workerd via `wrangler` 4.151.0 `createTestHarness`; real PHP 8.3.35 + Apache for live runs |

## Package versions

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MCP server, Streamable HTTP transport |
| `@cloudflare/workers-oauth-provider` | 1.2.3 | OAuth 2.1 authorization and resource server |
| `hono` | 4.13.13 | Authorization server routing and pages |
| `zod` | 4.6.7 | Tool input schemas |
| `@cfworker/json-schema` | 4.1.1 | Workers-compatible schema validator |
| `wrangler` | 4.151.0 | Build, dev, test harness runtime |
| `vitest` | 4.1.12 | Test runner |
| `@vitest/coverage-v8` | 4.1.12 | Coverage instrumentation |
| `@playwright/test` | 1.64.1 | Browser tests |
| `typescript` | 5.9.3 | Type checking; deliberately not 7.x |
| `@cloudflare/workers-types` | 5.20261015.1 | Worker bindings and runtime types |
| `@types/node` | 24.19.2 | Node APIs used by the harness |
| Bludit Community | 3.22.0 | GitHub release tarball, tag `3.22.0` |
| Bludit Pro | 3.22.0, build 20260510, commit `d5612ed979eeb9ac222a2272aab0c8b97cc09826` | Release archive |
| PHP (in the live containers) | 8.3.35 | With `gd` and `mbstring`, which Bludit requires |

## Results

```
# Hermetic — unit, integration and compatibility
Test Files  22 passed (22)
     Tests  378 passed (378)

# Live — real Bludit Community and Pro
Test Files  1 passed (1)
     Tests  24 passed (24)

# Browser — authorization server pages in Chromium
    9 passed
```

**411 tests, all passing.** No test is skipped or expected to fail.

### By suite

| Suite | Files | Tests | Kind | Needs |
|---|---|---|---|---|
| `test/unit/` | 11 | 222 | Pure logic, Node only | Nothing |
| `test/integration/` | 10 | 147 | Two Workers in workerd, real Service Binding, real HTTP | Nothing |
| `test/compat/` | 1 | 9 | Five modelled Bludit variants | Nothing |
| `test/live/` | 1 | 24 | Real Bludit Community and Pro in containers | Docker, `PRO_ZIP` for Pro |
| `test/browser/` | 1 | 9 | Playwright, headless Chromium, same in-process Workers | A cached Chromium build |

The first three are the hermetic suite: no network, no credentials, no Docker. They
are what `npm test` runs and what CI runs. The last two are opt-in and separate,
because a suite that needs a live system stops being run.

### Unit tests

| File | Tests | Covers |
|---|---|---|
| `ssrf.test.ts` | 49 | Scheme and shape rules, loopback handling, IPv4 ranges, IPv6 ranges including IPv4-mapped/NAT64/6to4, obfuscated literal normalisation, internal hostnames, redirect revalidation, response bounds |
| `rate-limit.test.ts` | 28 | Spec parsing and its fallbacks, window arithmetic and boundaries, bucket key derivation and PII-freedom, the `429` response in both body shapes, counter pruning |
| `scopes.test.ts` | 22 | Scope catalogue, per-tool scopes, absence of a deletion tool, step-up construction, JSON-RPC tool extraction, error mapping and redaction, redirect safety |
| `bludit-client.test.ts` | 20 | Token placement per HTTP method, envelope interpretation, HTTP status mapping, redaction, revision identity |
| `shared.test.ts` | 20 | HTML escaping, cookie serialisation and `__Host-` prefixes, site projection, write-input validation |
| `crypto.test.ts` | 18 | Token entropy, hashing determinism, HMAC, envelope encryption and AAD binding, IV freshness, password hashing |
| `proposals.test.ts` | 16 | Pairing proof verification, proposal applicability on every refusal path |
| `diff.test.ts` | 14 | Field diffing, unified diff, large-rewrite fallback, patch truncation, content summarisation |
| `production-config.test.ts` | 13 | The **deployable** configs: SSRF flag set, insecure site URLs off, rate limiting on, no secret in a var, issuer and resource agree, no route, no deploy step in CI |
| `capabilities.test.ts` | 10 | Capability reporting for every working/broken endpoint combination, edition honesty |
| `pats.test.ts` | 12 | Personal access token shape, digest determinism, scope parsing, and that a summary never carries the token or its digest |

### Integration tests

| File | Tests | Covers |
|---|---|---|
| `mcp-tools.test.ts` | 35 | All 19 tools against the mock API; proposal lifecycle; revision mismatches; upstream failure mapping; credential non-leakage; traversal keys; the content-scan subrequest cap |
| `oauth-security.test.ts` | 20 | Scope step-up, audience rejection, per-client isolation and revocation, per-account isolation, cross-account proposal rejection, PKCE, code replay, redirect-URI mismatch, unknown client, consent denial, CSRF, remembered consent, refresh, CIMD rejection |
| `security-controls.test.ts` | 15 | The four controls below, asserted together |
| `rate-limit.test.ts` | 14 | Every bucket driven to refusal over HTTP; window reset; per-client isolation; storage and PII; disabled mode |
| `site-connect.test.ts` | 11 | Pairing by ownership file and by Wizard HMAC, missing proof, wrong challenge, challenge reuse, URL binding, encryption at rest read out of D1, invalid proof |
| `production-shape.test.ts` | 7 | Boot under `global_fetch_strictly_public`, CIMD advertisement, resource metadata, full authorization, loopback refusal, cloud-metadata refusal |
| `smoke.test.ts` | 3 | Both Workers boot, schema applies, discovery chain works |
| `protocol-surface.test.ts` | 22 | The facts client compatibility turns on: the `401` challenge, no session id, protocol-revision negotiation with old and new clients, four `Accept` variants, CORS behaviour, and that all 19 tools carry all four annotation hints |
| `pats.test.ts` | 16 | Personal access tokens end to end: creation through the UI shown once, digest-only storage, bearer use, the same scope enforcement and tenancy as an OAuth token, no delete, review-before-write, immediate revocation, expiry, and per-token audit |
| `client-journey.test.ts` | 4 | The nine-step journey, walked twice — once per credential type |

#### Security-control confirmations

`security-controls.test.ts` exists so a reviewer can read one file and see the four
claims together, rather than reconstructing each from a feature test.

| Control | Asserted how |
|---|---|
| Credential encryption at rest | Ciphertext read back out of real D1; no plaintext; identical credentials on two sites produce different ciphertext (fresh IV plus site-id AAD); 14 read tools' outputs scanned for the token, the auth token, `_enc` and envelope internals; decryption proven by the live site accepting it |
| Grant revocation | Revoked client's token → `401` while another client's still works; refresh after revocation refused; per-client revocation confirmed in the UI listing |
| Cross-account isolation | 12 probes with a second account's site id, each `not_found` and never `forbidden`; no label, URL or site title in any response; the site is unchanged afterwards; a proposal is not applicable by another account and remains applicable to its owner |
| SSRF | Nine reserved/internal/credential-bearing URLs refused with the specific reason; three scheme refusals; and a test that documents that Miniflare does not enforce the platform egress flag locally |

## Client compatibility evidence

The twelve-client requirement is documented in
`docs/CLIENT_COMPATIBILITY_MATRIX.md`, with the analysis in
`CLIENT_GAP_ANALYSIS.md`. The test evidence is:

| Claim | Where it is asserted |
|---|---|
| All 19 tools declare `readOnlyHint` **and** `destructiveHint` | `protocol-surface.test.ts` |
| `401` carries `resource_metadata` and a scope; no client-side change needed | `protocol-surface.test.ts` |
| Four `Accept` header shapes work, where only one used to | `protocol-surface.test.ts` |
| Protocol revisions 2024-11-05 through 2026-07-28 are all served | `protocol-surface.test.ts` |
| No `Mcp-Session-Id` is ever issued | `protocol-surface.test.ts` |
| No legacy `/sse` endpoint; Streamable HTTP only | `protocol-surface.test.ts` |
| The nine-step journey works with an OAuth token **and** a personal access token | `client-journey.test.ts` |
| A personal access token gets the same scope enforcement, tenancy, safety gates and audit trail as an OAuth token | `pats.test.ts` |

**What this does not prove: that any client works.** No client product has been
run against this server. Every "tested version" cell in the compatibility matrix
says `not tested`, and four surfaces are recorded as unsupported or unknown.

## Live tests

The only evidence in this project of live compatibility. Run against real Bludit
Community 3.22.0 and real Bludit Pro 3.22.0, installed into disposable containers
by `scripts/live-bludit-up.sh`, connected through the real pairing flow.

| Test | Live-verified |
|---|---|
| Capability report (read, authenticated, endpoints, edition honesty) | Both editions |
| Read pages, settings, tags, categories | Both editions |
| Read one page in full; revision stable across reads | Both editions |
| `tags` round-trips as a comma-joined string; normaliser recovers the array | Both editions |
| A draft's tag is **not** indexed | Both editions |
| A published page's tag **is** indexed | Both editions |
| Edit moves the revision | Both editions |
| A missing page → `not_found`; a traversal key → `invalid_input` | Both editions |
| A wrong API token → `site_auth_failed` | Both editions |
| Connect the site through the pairing flow and list it, with no credential in the response | Both editions |
| 14 MCP operations end to end: list, read, settings, tags, categories, search, summary, verify, create, edit, propose, preview, apply, and a stale approval refused | Both editions |

Community and Pro produce **identical** results, which is expected: the two 3.22.0
trees are byte-identical in `bl-plugins/api/plugin.php` and in every kernel file the
API depends on. See `BLUDIT_COMPATIBILITY_MATRIX.md`.

### What live testing found

Three real defects that the mock had been hiding. The mock was wrong, not the
server's logic — but the effect was a crash. All three are fixed, and the mock now
reproduces them exactly.

| Finding | Effect before the fix |
|---|---|
| `tags` is a comma-joined **string**, not an array | `search_pages` and `get_related_pages` threw `internal_error`; `summarizePage` returned an empty tag list for every page |
| `category` is `false` when there is no match | `search_pages` threw `false.toLowerCase is not a function` |
| Only published/static/sticky pages are tag-indexed | A draft's tag never appeared in `list_tags`; now disclosed in the tool description |

## Defects found

Eleven, all fixed, all with regression tests. Full detail in
`SECURITY.md#findings`.

| # | Severity | Defect | Found by |
|---|---|---|---|
| 0 | High | Thirteen of nineteen tools omitted `destructiveHint`, which Claude's connector documentation requires on **every** tool | The protocol-surface probe written for the client-compatibility requirement |
| 0b | High | The transport answered `406` for every `Accept` header except the exact specification-compliant one | Same probe |
| 1 | High | IPv4-mapped (`::ffff:`) and NAT64/6to4 IPv6 addresses were **accepted** by the SSRF policy | Unit tests |
| 2 | High | The IPv6 prefix matcher double-shifted, so every IPv6 range check was wrong | Unit tests |
| 3 | High | `tags` is a string on the wire; two tools called `.some()` on it | **Live tests** |
| 4 | Medium | The remembered-consent `Set-Cookie` was dropped when the decision response was rebuilt | Integration tests |
| 5 | Medium | The `403` challenge named only the missing scope, not the complete set | Integration tests |
| 6 | Medium | `category` is `false`, not a string | **Live tests** |
| 7 | Medium | Unauthenticated `/sites` returned a 500 instead of redirecting | **Browser tests** |
| 8 | Low | `edit_page` did not report whether the body changed | Integration tests |
| 9 | Low | A 404 on `/api/pages` was reported as `not_found` rather than `capability_unavailable` | Integration tests |
| 10 | Low | The mock's tag listing used a malformed Set construction | Integration tests |
| 11 | Low | Dead code: unused helpers, a vestigial parameter, two pointless re-exports | Review |

Numbers 3, 6 and 7 are the argument for keeping three different kinds of test. Each
was invisible to the layer that was passing. Numbers 0 and 0b are the argument for
reading a client's official requirements and then asserting the server against
them: both were invisible to every test that existed before the compatibility
requirement, and the first of them would have blocked Claude outright.

## Worker bundle sizes

Measured by `wrangler deploy --dry-run`. The platform limit is 64 MiB uncompressed.

| Worker | Upload | Gzipped |
|---|---|---|
| `bludit-wizard-auth` | 391.47 KiB | 92.54 KiB |
| `bludit-wizard-mcp` | 1543.44 KiB | 272.64 KiB |

The MCP Worker is roughly four times larger because it carries the MCP SDK and the
Zod schemas for 19 tools.

## Coverage

Produced by `npx vitest run --coverage test/unit test/integration test/compat`
(V8, instrumenting `src/**`).

```
Statements  38.34% ( 691/1802 )
Branches    32.52% ( 469/1442 )
Functions   34.17% ( 135/395  )
Lines       37.85% ( 606/1601 )
```

**Read this before quoting the headline number.** That aggregate is **not** a
measure of how well tested this project is. V8 coverage is collected in the Node
process running Vitest, and most of this codebase does not execute there — it
executes inside **workerd**, in a separate process the instrumented Node process
cannot observe. Every file below showing 0% is in fact exercised by the
integration, compatibility and live suites.

So the honest reading is two-part.

### Modules the Node process genuinely covers

These are unit-tested directly, and their numbers are meaningful:

| Module | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `shared/ssrf.ts` | 87.62% | 78.86% | 95.65% | 95.56% |
| `shared/crypto.ts` | 94.49% | 92.10% | 95.65% | 94.56% |
| `shared/cookies.ts` | 83.33% | 75.00% | 80.00% | 91.30% |
| `shared/html.ts` | 80.00% | 60.00% | 75.00% | 80.00% |
| `shared/redirect.ts` | 100% | 100% | 100% | 100% |
| `shared/rate-limit.ts` | 71.42% | 59.25% | 85.71% | 69.56% |
| `bludit/capabilities.ts` | 96.96% | 97.29% | 100% | 96.87% |
| `bludit/client.ts` | 78.94% | 67.54% | 78.57% | 80.95% |
| `shared/scopes.ts` | 100% | 100% | 100% | 100% |
| `proposals/diff.ts` | 91.35% | 91.42% | 100% | 90.00% |
| `sites/registry-helpers.ts` | 100% | 82.35% | 100% | 100% |
| `mcp/tools/write-helpers.ts` | 77.50% | 80.43% | 100% | 96.55% |

Partially covered for the same reason — pure logic is unit-tested, the
binding-dependent part runs in workerd:

| Module | Statements | Why it is partly dark |
|---|---|---|
| `shared/rate-limit.ts` | 71.42% | The counter path needs D1 and is covered by the integration suite |
| `proposals/store.ts` | 45.45% | `assertProposalApplicable` is unit-tested; the D1 functions run in workerd |
| `sites/pairing.ts` | 20.68% | Proof comparisons are unit-tested; the D1 challenge functions run in workerd |
| `mcp/tools/intelligence.ts` | 20.56% | `summarizeContent` is unit-tested; the tool registrations run in workerd |
| `shared/pats.ts` | 25.00% | Token shape, digests, scope parsing and the summary projection are unit-tested; minting and verification need D1 and run in workerd |
| `shared/log.ts` | 6.25% | Called from workerd; its console output never reaches the Node process |
| `bludit/client.ts` | 78.94% | The fetch paths are covered in workerd by the mock and live suites |

### Modules reported at 0% that the integration suite covers

`auth/*` (eight files, including the new token UI), `mcp/app.ts`, `mcp/index.ts`, `mcp/server.ts`,
`mcp/tools/context.ts`, `mcp/tools/pages.ts`, `mcp/tools/result.ts`,
`mcp/tools/sites.ts`, `mcp/tools/taxonomy.ts`, `mcp/tools/write.ts`,
`sites/connect.ts`, `sites/credentials.ts`, `sites/registry.ts`.

These include the OAuth authorization flow, the consent page, session handling,
the site-connection flow, encryption at rest, the MCP transport, the HTTP
pre-flight and rate-limit enforcement. All are covered end to end by tests
asserting real behaviour — a token is issued, a `403` names the right scopes, a
challenge cannot be reused, ciphertext in D1 is not plaintext, a flooded bucket
returns `429`. Behavioural assertions, not percentage coverage, are the evidence
for those modules.

Getting a single honest coverage number would mean running the tests inside
workerd with `@cloudflare/vitest-pool-workers` and merging its coverage with this
run. That is worth doing and is not done.


## What is not covered

Honest gaps, each with what would close it.

| Gap | Why | How to close |
|---|---|---|
| **No real MCP client product** | The harness client follows the specification rather than reproducing a product | Run the procedure in `CLIENT_COMPATIBILITY.md` and record the result |
| **Live runs are loopback over plain http** | The containers are reached through the development allowance | Point the live suite at a remote HTTPS installation |
| **The Wizard PHP extension has not been live-tested** | `/api/wizard/*` is modelled from PHP source, and `/api/wizard/pair` does not exist in PHP at all — it is a proposal | Install the plugin and implement the proposed contract |
| **Later 3.22.x patches are modelled, not live** | Only 3.22.0 was downloaded and run | Stage another release and re-run the live suite |
| **Scheduled pages are modelled only** | The live pages were published or drafts | Create one with a future date on a live site |
| **The platform SSRF layer cannot be probed locally** | Miniflare does not enforce `global_fetch_strictly_public` | Verify after deployment; a test documents the gap |
| **No deployment** | Requires approval | `DEPLOYMENT.md`, then the post-deploy verification commands |
| **No load or soak test** | Nothing is deployed to load | Load-test after deployment |
| **Concurrency limits not measured** | D1's single-writer behaviour is documented, not measured here | Measure once there is traffic |
| **Image and file upload untested** | No tool exposes it | Out of scope |
| **Custom fields (`custom`) untested** | No tool surfaces them | Add a tool, or leave it |
| **PHP plugin install, upgrade and uninstall** | This project does not install or modify the PHP plugin | The PHP project's own concern |
| **Credential key rotation untested** | Not implemented | Implement, then test |
| **Accessibility not audited** | Semantic HTML, no framework, but no WCAG review | An accessibility audit |
| **No alerting tested** | Not implemented | Implement, then test |

## Reproducing

```bash
git checkout <commit>
npm ci
npm run typecheck
npm test                     # 324 hermetic tests
npm run test:browser         # 9 browser tests
npx vitest run --coverage    # writes reports/coverage/
npm run build:auth && npm run build:mcp

# Live, optional, needs Docker
PRO_ZIP=/path/to/bludit-pro-3.22.0.zip scripts/live-bludit-up.sh both
npm run test:live            # 24 live tests
scripts/live-bludit-up.sh --down
```

The hermetic suite needs no network access, no credentials, no Cloudflare account
and no Bludit installation. It starts its own workerd instances, its own HTTP mock
CMS, and its own in-memory D1. That was a design requirement: a suite that needs a
live system is a suite that stops being run.

Two profiles run the same Workers under different compatibility flags
(`DEPLOYMENT.md#testing-profiles`), because the flag that CIMD requires also blocks
the loopback mock — and that tension is itself worth testing.
