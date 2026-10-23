# Project Status

## Current Phase

Released

The local stdio edition is implemented, licensed, tested and published as a GitHub
release (source tag plus tarball asset). The self-hosted HTTP transport remains
designed only; the Cloudflare Workers transport is preserved but not deployed.

## Repository State

Canonical documents live at the repository root since 2026-10-16. Detailed
documents remain under `docs/`.

<!-- prodoc:observed:start -->
<!-- Observed from Git metadata only, by `prodoc update`. This block is not evidence that the implementation or its tests are correct; record that under `## Verification Evidence`. -->
- **Observed branch:** feat/local-stdio-edition
- **Observed commit:** a8efd684361a4b092655a2313428e360bd27e877
- **Observed working tree:** dirty
- **Observed at:** 2026-10-23T20:26:52Z
<!-- prodoc:observed:end -->

Work happened in a dedicated Git worktree at
`/home/evan/Projects/Bludit-Wizard-MCP-stdio`, because a concurrent session was
editing `docs/hosting/` in the primary worktree. That isolation held: the concurrent
session's four modified and one untracked file were never touched.

For the release, `main` was fast-forwarded to the accepted release commit and is the
public default branch. `feat/local-stdio-edition` is retained for traceability. The
legacy worktree (`/home/evan/Projects/Bludit-Wizard-MCP`, branch
`feat/remote-mcp-oauth-v1`) is retained: its commits are already in `main`, but it
holds uncommitted `docs/hosting/` analysis and is the working directory of an active
session. See decision D-0012.

## Verification Evidence

- **Verification:** commit `2faf72d` — the local stdio edition passes 40 hermetic
  tests, covering configuration, the MCP protocol, all 19 tools, the write gates, the
  no-delete policy, secret redaction and network safety — evidence `test/local/`
- **Verification:** commit `2faf72d` — the local stdio edition passes 6 live tests
  against real Bludit Community 3.22.0 in a disposable Docker container — evidence
  `test/live/local-stdio-live.test.ts`
- **Verification:** commit `2faf72d` — the core extraction changed no hosted
  behaviour: 73 tests pass over every call site it touched — evidence
  `test/integration/mcp-tools.test.ts`
- **Verification:** commit `2faf72d` — both Cloudflare Workers still build
  (`wrangler deploy --dry-run`, no deploy) — evidence `wrangler.auth.jsonc`,
  `wrangler.mcp.jsonc`
- **Verification:** commit `2faf72d` — the packed tarball installs in a clean
  directory with `--omit=dev` and no build tooling, and passes 15 checks — evidence
  `package.json` (`bin`, `files`, `prepack`)
- **Verification:** commit `2faf72d` — the full hermetic suite passes: 436 tests
  across 27 files, 0 failed — evidence `reports/junit.xml`
- **Verification:** commit `993cc02` with the acceptance fix uncommitted — the full
  hermetic suite passes 438 tests across 27 files (0 failed), the browser suite
  passes 9 tests, and a live acceptance run covered all 19 tools against a
  disposable Bludit site. One defect was found and fixed: a non-JSON `2xx` body was
  reported as an empty success; `src/bludit/client.ts` now raises `upstream_error`,
  with two regression tests. Evidence `docs/LIVE_ACCEPTANCE_REPORT.md`,
  `docs/evidence/live-acceptance-2026-10-17.json`, `reports/playwright-junit.xml`
- **Verification:** commit `a8efd68` — release verification: `npm ci` (0
  vulnerabilities), `npm run typecheck`, `npm test` (438 tests / 27 files, 0
  failed), `npx playwright test` (9 passed), `npm run test:live` against real
  Bludit Community 3.22.0 in Docker (18 passed: 12 hosted compatibility + 6 local
  stdio), and `npm pack` (51 files). A clean `npm install --prefix` of the tarball
  reports version 1.0.0 and advertises all nineteen tools over stdio. Evidence
  `reports/junit.xml`, `reports/live-junit.xml`, `reports/playwright-junit.xml`,
  `docs/RELEASE_NOTES_v1.0.0.md`.

## Completed Work

- **Implemented:** portable core extracted behind three ports — `SiteSource`,
  `AuditSink`, `ProposalStore`. `src/mcp/tools/ports.ts`, `src/mcp/tools/d1-ports.ts`,
  rewritten `src/mcp/tools/context.ts`. No tool body was rewritten.
- **Implemented:** local stdio edition (Transport A), the primary distribution —
  `src/local/{config,ports,context,server,index}.ts`, `test/local/` (40 tests)
- **Implemented:** packaging for distribution — `bin`, `files`, `build:local`,
  `prepack` in `package.json`; `tsconfig.local-build.json`. **Not published.**
- **Implemented:** two new tools-local behaviour sources: `src/shared/log.ts`
  gained a swappable diagnostic writer (defaults to the console, so the hosted
  transport is unchanged); `createMcpServer` gained an optional `instructions`
  argument
- **Implemented:** Cloudflare adapter preserved. Behaviour unchanged, both Workers
  build, and the hosted tests that cover the changed call sites pass.
- **Implemented:** documentation — `docs/LOCAL_STDIO.md` (setup guide),
  `docs/REUSE_AUDIT.md` (reuse and extraction record),
  `docs/SELF_HOSTED_HTTP.md` (remote design, not implemented). `README.md`,
  `docs/ARCHITECTURE.md` and `docs/SECURITY.md` now state per-transport scope.
- **Implemented:** canonical root documents created from the ProDoc Guard templates:
  `PRODUCT_REQUIREMENTS.md`, `DECISION_LOG.md` (D-0001 … D-0006), `PROJECT_STATUS.md`
- **Implemented:** upstream attribution and MIT licensing retained; upstream history
  intact at 37 commits to `398b2f6 init`; `src/index.js` still upstream's, unchanged
- **Implemented:** concurrent-session work in `docs/hosting/` preserved untouched,
  including its four modified and one untracked file

## Tests

Measured, not estimated. Cloudflare-only results are **not** evidence of stdio
behaviour, and the stdio results are **not** evidence about the hosted adapter. The
two are reported separately for that reason.

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Local stdio (hermetic) | `npm run test:local` | Pass | 40 tests across 4 files: config 12, protocol/tools 17, spawned process 6, network safety 5 — `test/local/` |
| Live Bludit Community 3.22.0 | `npm run test:live` | Pass | 18 tests in the full live suite (12 hosted compatibility + 6 local stdio), real container, real API — `test/live/`, `reports/live-junit.xml` |
| Live Bludit Pro 3.22.0 | `PRO_ZIP=… npm run live:up` | Not run | Pro is not publicly downloadable; `scripts/live-bludit-up.sh` skipped it and said so — `scripts/live-bludit-up.sh` |
| Hosted path after extraction | `npx vitest run test/integration/mcp-tools.test.ts test/integration/pats.test.ts test/integration/client-journey.test.ts test/integration/security-controls.test.ts` | Pass | 73 tests, covering every call site the extraction touched — `reports/junit.xml` |
| Full hermetic suite | `npm test` | Pass | 438 tests across 27 files, 0 failed, including the local stdio tests — `reports/junit.xml` |
| Cloudflare Worker builds | `npm run build:auth` and `npm run build:mcp` | Pass | Both built under wrangler `--dry-run`; nothing uploaded — `wrangler.auth.jsonc`, `wrangler.mcp.jsonc` |
| Clean package install | `npm pack` then `npm install --prefix` of the tarball | Pass | `--version` reports 1.0.0; a real stdio client lists all 19 tools and no deletion tool — `docs/RELEASE_NOTES_v1.0.0.md` |
| Browser authorization pages | `npx playwright test` | Pass | 9 tests, 0 failed — `reports/playwright-junit.xml` |

What is **not** claimed:

- **OpenCode 2.0.21 is the only verified MCP client**, and only for the local stdio
  edition. Other clients and the hosted HTTP transports remain unverified.
- The live run covers **Bludit Community only**; Pro is not publicly downloadable.

## Known Defects

- None known in the local stdio edition. The malformed-JSON success defect found
  during acceptance was fixed before release (`src/bludit/client.ts`, two regression
  tests).

Two observations that are design, not defects, recorded so they are not mistaken for
bugs later:

1. **`create_page` and `edit_page` write immediately, with no per-call `confirm`.**
   This is the existing, documented hosted behaviour (`docs/SECURITY.md`): the
   review-before-write control is the `propose_page_edit` → `apply_approved_edit`
   path, and `apply_approved_edit` does require `confirm: true`. The local edition
   inherits it deliberately. Requiring confirmation on direct writes would change
   shared behaviour and would need its own decision.
2. **A local install pulls Cloudflare-only dependencies it never uses.** The local
   runtime graph is the MCP SDK, Zod and Node builtins, but `package.json` declares
   Hono, `@cloudflare/workers-oauth-provider` and `@cfworker/json-schema` for the
   Worker build, so a local install is ~98 packages / ~30 MB. Recorded in
   `docs/REUSE_AUDIT.md` §8. Fixing it touches the hosted build's dependency
   resolution.
3. **A git-URL install would not build `dist/`.** `prepack` covers `npm pack` and
   registry installs, and that path is verified end to end. `npm install
   github:<owner>/<repo>` runs `prepare` instead, so the `bin` entry would not
   resolve. Adding `"prepare": "npm run build:local"` fixes it; it is left out
   because it changes `npm install` behaviour in every checkout and deserves its own
   verification. Recorded in `docs/REUSE_AUDIT.md` §8.

## Blockers

1. **Uncommitted hosting analysis in the legacy worktree.** Four files under
   `docs/hosting/` are modified and one (`PHP_ADAPTATION_ANALYSIS.md`) is untracked,
   none of them by this work. The worktree is retained until that work is dealt with
   and no active session depends on it. It does not block the release.
2. **Five files were committed accidentally by this session** in `7b89401` via a
   `git add -A` (and one in `bfa4da8`). History was **not** rewritten to fix
   attribution, per instruction. Those files are otherwise untouched. How to
   attribute them still needs a decision.
3. **The remote HTTP implementation is not authorised.** The design is delivered in
   `docs/SELF_HOSTED_HTTP.md`; implementation awaits explicit approval and answers to
   the five open questions in §14 of that document.
4. **Bludit Pro could not be live-tested**, because its archive is not publicly
   available. Unblocked by setting `PRO_ZIP`.
5. **Only OpenCode has been verified as an MCP client**, and only over local stdio.
   Other client products and the hosted transports remain unverified.
6. **npm registry publication was not authorised** for this release; the package is
   distributed as a GitHub release asset with `private: true` retained.

## Next Actions

1. Resolve blocker 2 — agree how to attribute the accidentally committed files.
2. Decide the three structural questions in `docs/SELF_HOSTED_HTTP.md` §14 before
   any remote implementation begins.
3. Run the live suite against Bludit Pro by supplying `PRO_ZIP`, to close the
   Community-only gap.
4. Verify additional MCP clients against the local stdio edition, and record each
   result.
5. Decide whether `src/index.js` (upstream's stdio server) is deprecated in favour of
   the local edition, and on what timeline.
6. If npm publication is wanted later, flip `private: false` in a dedicated commit
   and publish the verified tarball (decision D-0010).

## Release Status

**Released: v1.0.0 on GitHub. Not published to npm. Not deployed.**

- GitHub repository: <https://github.com/gitdamnit/bludit-wizard-mcp>
- Release: <https://github.com/gitdamnit/bludit-wizard-mcp/releases/tag/v1.0.0>
- Package asset: `bludit-wizard-mcp-1.0.0.tgz`
- Licence: GPL-3.0-only, upstream MIT notice retained.
- npm registry: **not published**; `private: true` retained (D-0010).

No hosting service is operated for anyone. The Cloudflare Workers were validated
with `wrangler deploy --dry-run` only; nothing was uploaded.
