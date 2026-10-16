# Test report

Measured output, not recollection. Every number below came from a run recorded in
this project.

## Run metadata

| | |
|---|---|
| Test date | 2026-10-16 |
| Test suite at | `ebbf144` (254 Vitest tests) and `6414040` (9 Playwright tests) |
| Coverage measured at | the working tree that became `972be8e` |
| Branch | `feat/remote-mcp-oauth-v1` |
| Upstream pin | `73b5ddcb92015d1359370ba2613090eef6af910c` |
| Bludit build inspected | PRO 3.22.0, build 20260510 |
| Platform | Linux 7.0.0-38-generic |
| Node.js | 22.23.2 |
| npm | 10.9.8 |
| Runtime under test | workerd, via `wrangler` 4.151.0's `createTestHarness` (Miniflare) |

## Package versions

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MCP server, Streamable HTTP transport |
| `@cloudflare/workers-oauth-provider` | 1.2.3 | OAuth 2.1 authorization server and resource server |
| `hono` | 4.13.13 | Authorization server routing and pages |
| `zod` | 4.6.7 | Tool input schemas |
| `@cfworker/json-schema` | 4.1.1 | Workers-compatible schema validator for the SDK |
| `wrangler` | 4.151.0 | Build, dev, and the test harness runtime |
| `vitest` | 4.1.12 | Test runner |
| `@vitest/coverage-v8` | 4.1.12 | Coverage instrumentation |
| `typescript` | 5.9.3 | Type checking; deliberately not 7.x, see `DEPLOYMENT.md` |
| `@cloudflare/workers-types` | 5.20261015.1 | Worker bindings and runtime types |
| `@types/node` | 24.19.2 | Node APIs used by the test harness |
| Bludit build inspected | PRO 3.22.0, commit `d5612ed979eeb9ac222a2272aab0c8b97cc09826` | Source of the mock's behaviour |

## Results

```
# Vitest — unit, integration and compatibility
Test Files  14 passed (14)
     Tests  254 passed (254)
  failures  0     errors  0

# Playwright — authorization server pages in Chromium
    9 passed
```

Machine-readable results: `reports/junit.xml` (JUnit XML, written by every run).
`reports/` is git-ignored because it is build output.

### By suite

| Suite | Files | Tests | Kind | Runtime |
|---|---|---|---|---|
| `test/unit/` | 8 | 169 | Pure logic, Node environment, no Workers | ~0.6 s |
| `test/integration/` | 5 | 76 | Two Workers in workerd, real Service Binding, real HTTP | ~2.5 min |
| `test/compat/` | 1 | 9 | Modelled Bludit variants, table-driven | ~50 s |
| `test/browser/` | 1 | 9 | Playwright, headless Chromium, against the same in-process Workers | ~1.1 min |

Total: **263 tests**. `reports/junit.xml` and `reports/playwright-junit.xml` are
written by `npm test` and `npm test:browser`; `reports/coverage/` by
`npx vitest run --coverage`. All three are git-ignored build output.

### Unit tests

| File | Tests | Covers |
|---|---|---|
| `ssrf.test.ts` | 49 | Scheme and shape rules, loopback handling, IPv4 ranges, IPv6 ranges including IPv4-mapped/NAT64/6to4, obfuscated literal normalisation, internal hostnames, redirect revalidation, response bounds |
| `scopes.test.ts` | 22 | Scope catalogue, per-tool scope assignment, the absence of a deletion tool, step-up challenge construction, JSON-RPC tool extraction, error payload mapping and redaction, redirect-target safety |
| `shared.test.ts` | 20 | HTML escaping and script embedding, cookie serialisation and `__Host-` prefixes, site projection (no credential leakage), write-input validation |
| `bludit-client.test.ts` | 20 | Token placement per HTTP method, envelope interpretation for legacy and current builds, HTTP status mapping, redaction of upstream messages, revision identity |
| `crypto.test.ts` | 18 | Token entropy, hashing determinism, HMAC, envelope encryption round-trip and AAD binding, IV freshness, password hashing and malformed-hash handling |
| `proposals.test.ts` | 16 | Pairing proof verification, well-known body comparison, proposal applicability for every refusal path |
| `diff.test.ts` | 14 | Field diffing, unified diff, large-rewrite fallback, patch truncation, content summarisation |
| `capabilities.test.ts` | 10 | Capability reporting for every working/broken endpoint combination, edition honesty, probe failure resilience |

### Integration tests

| File | Tests | Covers |
|---|---|---|
| `mcp-tools.test.ts` | 35 | All 19 tools end to end against the mock Bludit site; the proposal lifecycle; revision mismatches; upstream failure mapping; credential non-leakage; page-key traversal rejection |
| `oauth-security.test.ts` | 20 | Scope step-up, resource-audience rejection, per-client isolation and revocation, per-account isolation, cross-account proposal rejection, PKCE enforcement, code replay, redirect-URI mismatch, unregistered redirect URI, unknown client, consent denial, consent page contents, CSRF enforcement, remembered consent, refresh, CIMD rejection |
| `site-connect.test.ts` | 11 | Pairing proof by ownership file and by Wizard HMAC, missing proof, wrong challenge, unknown challenge, challenge reuse, challenge bound to another URL, encryption at rest verified in D1, Wizard key rejection, invalid proof |
| `production-shape.test.ts` | 7 | Boot under `global_fetch_strictly_public`, CIMD advertisement, resource metadata, full authorization, loopback refusal, cloud-metadata refusal, internal-hostname refusal |
| `smoke.test.ts` | 3 | Both Workers boot, D1 schema applies, discovery chain works |

### Compatibility tests

`bludit-editions.test.ts` runs five modelled variants and asserts per-variant
outcomes, plus four cross-variant consistency assertions. Results are written to
`reports/bludit-compatibility.json`; the interpretation is in
[BLUDIT_COMPATIBILITY_MATRIX.md](BLUDIT_COMPATIBILITY_MATRIX.md).

### Browser tests

| Test | Covers |
|---|---|
| Landing page | Renders, links to sign in and sign up |
| Sign-up and session | Lands on `/sites`; the session cookie is `HttpOnly` and `SameSite=Lax`, and is unreadable from page script |
| Pairing challenge form | Renders the challenge; the connect form carries the CSRF token and challenge forward, and names the exact well-known path for the URL entered |
| Escaping | A label containing `"><img src=x onerror=alert(1)>` produces no element and is displayed as literal text |
| Unauthenticated `/sites` | Redirects to sign in rather than failing |
| Return to destination | `/sites` → sign in → back to `/sites` |
| Failure text parity | A wrong password and an unknown account produce identical text |
| Password policy | A short password is refused at sign-up |
| Connected clients | Protected; shows an empty state when signed in |

## Coverage

Produced by `npx vitest run --coverage` (V8, instrumenting `src/**`), measured on
the working tree that became commit `972be8e`. The later commit `e4c92e6` removed
unused code only, and `ebbf144` added a session guard in a module already at 0%
below, so neither changes these figures.

**Read this before quoting the headline number.**

```
Statements  39.79% ( 634/1593 )
Branches    33.28% ( 432/1298 )
Functions   33.04% ( 114/345  )
Lines       39.18% ( 560/1429 )
```

That aggregate is **not** a measure of how well tested this project is. V8
coverage is collected in the Node process running Vitest. Most of this codebase
does not execute there — it executes inside **workerd**, in a separate process
that the instrumented Node process cannot observe. Every file below showing 0%
is in fact exercised by the integration and compatibility suites, which is where
the 85 workerd-driving tests live.

So the honest reading is two-part.

### Modules the Node process genuinely covers

These are unit-tested directly, and their numbers are meaningful:

| Module | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `shared/ssrf.ts` | 87.62% | 78.86% | 95.65% | 95.56% |
| `shared/crypto.ts` | 94.49% | 92.10% | 95.65% | 94.56% |
| `shared/cookies.ts` | 83.33% | 75.00% | 80.00% | 91.30% |
| `shared/html.ts` | 80.00% | 60.00% | 75.00% | 80.00% |
| `bludit/capabilities.ts` | 96.96% | 97.29% | 100% | 96.87% |
| `bludit/client.ts` | 81.55% | 68.75% | 81.81% | 84.37% |
| `proposals/diff.ts` | 91.35% | 91.42% | 100% | 90.00% |
| `sites/registry-helpers.ts` | 100% | 82.35% | 100% | 100% |
| `mcp/tools/write-helpers.ts` | 77.50% | 80.43% | 100% | 96.55% |

Partially covered for the same reason — the pure logic is unit-tested and the
binding-dependent part runs in workerd:

| Module | Statements | Why it is partly dark |
|---|---|---|
| `proposals/store.ts` | 45.45% | `assertProposalApplicable` is unit-tested; the D1 functions run in workerd |
| `sites/pairing.ts` | 20.68% | The proof comparisons are unit-tested; the D1 challenge functions run in workerd |
| `mcp/tools/intelligence.ts` | 20.56% | `summarizeContent` is unit-tested; the tool registrations run in workerd |
| `shared/log.ts` | 6.25% | Called from workerd, whose console output does not reach the Node process |

### Modules reported at 0% that are covered by the integration suite

`auth/accounts.ts`, `auth/app.ts`, `auth/consent.ts`, `auth/index.ts`,
`auth/oauth.ts`, `auth/sessions.ts`, `auth/sites-ui.ts`, `mcp/app.ts`,
`mcp/index.ts`, `mcp/server.ts`, `mcp/tools/context.ts`, `mcp/tools/pages.ts`,
`mcp/tools/result.ts`, `mcp/tools/sites.ts`, `mcp/tools/taxonomy.ts`,
`mcp/tools/write.ts`, `sites/connect.ts`, `sites/credentials.ts`,
`sites/registry.ts`.

These include the OAuth authorization flow, the consent page, session handling,
the site-connection flow, encryption at rest, the MCP transport and the HTTP
pre-flight — all of which are exercised end to end by tests asserting real
behaviour (a token is issued, a `403` names the right scopes, a challenge cannot
be reused, ciphertext in D1 is not plaintext). Behavioural assertions, not
coverage percentages, are the evidence for those modules.

Getting a single honest coverage number would mean running the tests inside
workerd with `@cloudflare/vitest-pool-workers` and merging its coverage with the
Node run. That is worth doing and is not done.

<!-- COVERAGE-TABLE -->

## Defects found by this suite

Seven real defects in this codebase were found by these tests before any
deployment. They are listed with their severity in
[SECURITY.md](SECURITY.md#findings). The two high-severity ones were both in the
SSRF policy — IPv4-mapped and NAT64 IPv6 forms were accepted, and the prefix
matcher was wrong for every IPv6 range. Neither is reachable by reading the code
casually; both are trivially reachable by trying.

## Worker bundle sizes

Measured by `wrangler deploy --dry-run`. The platform limit is 64 MiB uncompressed.

| Worker | Upload | Gzipped |
|---|---|---|
| `bludit-wizard-auth` | 382.78 KiB | 90.45 KiB |
| `bludit-wizard-mcp` | 1535.71 KiB | 270.26 KiB |

The MCP Worker is roughly four times larger because it carries the MCP SDK and
the Zod schemas for 19 tools.

## What is not covered

Honest gaps, each with what would close it.

| Gap | Why | How to close |
|---|---|---|
| **No live Bludit site** | All CMS behaviour is tested against a mock reproduced from the shipped `bl-plugins/api/plugin.php` | Connect a disposable Community and a disposable Pro installation and re-run the compatibility operations |
| **Bludit Community's plugin source was not inspected** | Only the Pro 3.22.0 build was available | Diff `bl-plugins/api/plugin.php` between editions |
| **No real MCP client** | The harness client follows the specification rather than reproducing a product | Run the procedure in [CLIENT_COMPATIBILITY.md](CLIENT_COMPATIBILITY.md) |
| **No Cloudflare deployment** | Deploying requires explicit approval | `DEPLOYMENT.md`, then the post-deploy verification commands |
| **PHP Wizard endpoints are unverified** | `/api/wizard/*` is modelled from PHP source, and `/api/wizard/pair` does not exist in PHP at all — it is a proposal | Install the plugin on a disposable site and confirm behaviour, including the proposed pairing contract |
| **PDF and image parsing not exercised** | No tool accepts a file | Out of scope |
| **Image and file upload not tested** | No tool exposes it | Out of scope; the API supports it |
| **Custom fields (`custom`) untested** | No tool surfaces them | Add a tool, or leave it |
| **Plugin install, upgrade and uninstall** | This project does not install or modify the PHP plugin | Test in the PHP project |
| **No load or soak test** | Nothing is deployed to load | Load-test after deployment |
| **Concurrency limits not probed** | D1's single-threaded-per-database behaviour is documented, not measured here | Measure once there is traffic |
| **Credential key rotation untested** | Not implemented | Implement, then test |
| **Rate limiting untested** | Not implemented | Implement, then test |

## Reproducing

```bash
git checkout <commit>
npm ci
npm run typecheck
npm test                 # writes reports/junit.xml
npx vitest run --coverage   # writes reports/coverage/
npm run build:auth && npm run build:mcp
```

The suite needs no network access, no credentials, no Cloudflare account and no
Bludit installation. It starts its own workerd instances, its own HTTP mock CMS,
and its own D1 database in memory. That was a design requirement: a test suite
that needs a live site is a test suite that stops being run.

Two profiles run the same Workers under different compatibility flags
(`docs/DEPLOYMENT.md#testing-profiles`), because the flag that CIMD requires also
blocks the loopback mock — and that tension is itself worth testing.
