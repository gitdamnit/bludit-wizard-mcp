# Live acceptance report — Bludit Wizard MCP (local stdio)

- **Date:** 2026-10-17
- **Product:** Bludit Wizard MCP
- **Transport under test:** local stdio (`dist/local/index.js`)
- **Target site:** a disposable Bludit installation at
  `lightsalmon-caribou-519069.hostingersite.com` (credentials intentionally not
  recorded here)
- **Client under test:** OpenCode 2.0.21, through its real MCP tool interface
- **Branch / commit:** `feat/local-stdio-edition` / `993cc028e148e6db956721facfc75e1ef1f8d36e`

## Executive summary

**Outcome: PASS — ready for release review, not yet released.**

All 19 registered tools were inventoried and exercised against the live site or
through a deterministic isolated fixture. Reads, draft creation, direct edits,
proposals, previews, approved applies, replay protection, stale-revision refusal
and negative verification all behaved as documented. Authentication boundaries
and SSRF policy held. No credential appeared in a tool response, log or
Git-tracked file.

One defect was found and fixed: a `2xx` upstream response whose body was not JSON
was silently treated as `{}`, so a broken host could be reported as an empty but
successful page list. The fix is in `src/bludit/client.ts`, covered by two new
regression tests.

Automated evidence: **438 hermetic tests in 27 files passed**, **9 browser tests
passed**, `tsc --noEmit` clean, and the package dry-run produced the expected 50
files. The Docker-backed live suite (`npm run test:live`) was **not run** in this
session; it needs Docker and its own credentials.

Two limitations are real and are documented below rather than hidden: concurrent
writers pinned to the same revision can still race (Bludit has no conditional
write), and proposals are process-local by design.

## Environment

| | |
|---|---|
| Node.js | v22.23.2 |
| MCP SDK | 1.32.1 |
| Server package | `bludit-wizard-mcp` 0.1.0 |
| Executable | `/home/evan/Projects/Bludit-Wizard-MCP-stdio/dist/local/index.js` |
| Transport | MCP stdio (`StdioServerTransport`), diagnostics on stderr |
| OpenCode | 2.0.21 |
| Config | `~/.config/opencode/opencode.jsonc`, server id `bludit-wizard-mcp-stdio` |
| Target | disposable Bludit site (Hostinger), 3 published pages at start |

The executable reported `serverInfo: { name: "bludit-wizard-mcp", version: "0.1.0" }`
and protocol `2025-06-18`.

## Tool coverage matrix

All 19 tools were called through OpenCode. “Live” means the call reached the
disposable Bludit site.

| # | Tool | Class | Test performed | Result |
|---|---|---|---|---|
| 1 | `list_sites` | read | Listed the single configured site, with and without capabilities | PASS |
| 2 | `select_site` | read | By id `local`, by exact hostname; unknown id refused with `not_found` and the available list | PASS |
| 3 | `get_site_capabilities` | read | Default call, cached repeat, forced `refresh`; edition reported as `unknown` with the documented note | PASS |
| 4 | `get_website_settings` | read | Live settings (`title`, `slogan`, `theme`, `itemsPerPage`, URLs); refused for an unknown site | PASS |
| 5 | `list_pages` | read | Published, drafts included, pagination (`numberOfItems`/`pageNumber`), page past the end, all filters false, untagged | PASS |
| 6 | `get_page` | read | Published page, session draft, proposal-edited page, unknown key (`not_found`), traversal/NUL keys (`invalid_input`), explicit `site` argument | PASS |
| 7 | `get_drafts` | read | Full list, `numberOfItems`, accurate membership | PASS |
| 8 | `get_scheduled_pages` | read | Empty site response, `numberOfItems: -1` | PASS |
| 9 | `list_categories` | read | 3 categories (General, Music, Videos) | PASS |
| 10 | `list_tags` | read | Accurate empty list with the indexing note; unknown site refused | PASS |
| 11 | `search_pages` | read | Exact title, partial phrase, absent term, fixture keyword, case variation, drafts, content search with `scan_limit`, empty query and invalid `limit` rejected by the schema | PASS |
| 12 | `get_content_summary` | read | Fixture A; deterministic repeat identical; unknown page `not_found` | PASS |
| 13 | `get_related_pages` | read | Fixture A returned fixture B with reasons; deterministic repeat identical; unknown page `not_found` | PASS |
| 14 | `create_page` | write | Draft creation A–H, 4 000-character body, Unicode/special title, duplicate title, missing title, missing content, invalid enum | PASS |
| 15 | `edit_page` | write | Pinned edit, stale `expected_revision`, no revision, no-op edit, unknown key, attempt to clear content | PASS |
| 16 | `propose_page_edit` | proposal | Edit proposal, create proposal, multiple proposals on one page, no-op proposal rejected, unknown page, no fields | PASS |
| 17 | `preview_page_changes` | read | Field-level title change plus body diff; no-write guarantee; unknown page; no fields | PASS |
| 18 | `apply_approved_edit` | write | Apply edit, apply create, replay refusal, stale refusal, unknown id, expired proposal, `confirm: false`, two proposals applied concurrently | PASS with limitation (see concurrency) |
| 19 | `verify_page_update` | read | Correct revision/title/type/content, wrong revision, wrong title, wrong type, absent content, no expectations | PASS |

No deletion tool exists in the catalogue (confirmed from `tools/list`).

## Functional results

### Reads

Reads never fabricated content: an unknown page always produced `not_found` with
HTTP 404 in the details, never an empty page. Page counts were consistent
(3 published; 7 drafts mid-run, 10 after the final fixtures). Pagination returned
`hasMore: true` for a middle page and `0`/`hasMore: false` past the end.

`get_website_settings` requires the user auth token (Bludit's `/api/settings` is
authenticated); with the API token only it returns `site_auth_failed`, which is
accurate, not a bug.

### Draft creation

Fixtures used the marker `BW-ACC-20261017-2115` and were created as `draft`:

| Key | Purpose |
|---|---|
| `bw-acc-20261017-2115-a` | structured content, Unicode, HTML-like text |
| `bw-acc-20261017-2115-b` | related-content fixture |
| `bw-acc-20261017-2115-c` | edit, conflict, proposal and concurrency work |
| `bw-acc-20261017-2115-d` | 4 000-character body |
| `bw-acc-20261017-2115-e-—-café-amp-quot-quotes-quot-lt-t` | Unicode and special-character title |
| `bw-acc-20261017-2115-f` | created through propose/apply |
| `bw-acc-20261017-2115-g` | created through propose/apply |
| `bw-acc-20261017-2115-h` | read-after-create visibility |

Every creation was read back and checked for title, body, type, site and revision;
`ok: true` alone was never treated as evidence.

Duplicate-title behaviour: creating a second page with fixture A's title produced
the key `...-a-0`; fixture A kept its original revision and content. Bludit does
not overwrite. Unicode titles are kept, but Bludit derives a slug containing the
em dash and URL-encoded entity fragments; this is upstream slug behaviour and is
recorded as a limitation, not changed.

HTML-like input is escaped by Bludit on store (`<script>` becomes
`&lt;script&gt;`), so an exact byte round-trip of raw HTML is not expected. The
text is preserved and safe.

### Editing, proposals, verification

- Pinned edit: revision changed and matched the previous read.
- Stale `expected_revision`: `revision_mismatch`, content unchanged.
- No-op edit: reported success, revision unchanged, content unchanged.
- Edit without `expected_revision`: allowed and verified.
- `propose_page_edit` did **not** write: the page revision and body were identical
  before and after proposing.
- Preview and proposal agreed (same `+2/−0` body diff; title reported as a field
  change).
- Apply reported `verified: true` only after its own live read-back.
- Replay: `conflict` ("already applied"); no second write.
- Stale after an intervening direct edit: `revision_mismatch`.
- Unknown proposal: `not_found`. Expired proposal (0-second TTL fixture):
  `proposal_expired`.
- `verify_page_update` returned field-by-field false checks for every deliberately
  wrong expectation, and did not throw a false success.

## Security results

| Probe | Result |
|---|---|
| Missing API token | Server refused to start, listing the missing variable |
| Invalid API token | `site_auth_failed`, no data disclosed |
| Missing auth token, write | `site_auth_failed` before any upstream write; no page created |
| Invalid auth token | Reads succeed; settings and writes return `site_auth_failed` |
| Loopback `127.0.0.1` / `localhost` | Rejected unless `BLUDIT_ALLOW_INSECURE_URLS=true` (development escape hatch) |
| Private / reserved `10.0.0.5`, `192.168.1.10`, `169.254.169.254` | Rejected |
| `ftp://`, malformed URL, `user:pass@host`, port 99999 | Rejected with a specific reason |
| 302 redirect to `169.254.169.254` | `invalid_input`; redirect target re-validated |
| Upstream 500 | `upstream_error` |
| Upstream hang | `site_unreachable` after the 12 s timeout |
| Oversized body (3 MiB) | `site_unreachable` ("response exceeded the maximum accepted size") |
| Malformed JSON with HTTP 200 | **defect** — previously reported success; now `upstream_error` after the fix |
| Credentials in responses/logs | None found; audit lines contain tool, outcome, site id and a stable code only |
| Credentials in Git-tracked files | None in either worktree |

Path-like keys (`../etc/passwd`, embedded NUL) are refused by the client with
`invalid_input` before a request is made.

Malformed JSON-RPC framing (`this is not json-rpc`) did not kill the server: the
subsequent `initialize` and `tools/call` requests were answered normally.

### Concurrency — documented limitation

Two `edit_page` calls issued simultaneously with the same correct
`expected_revision` both succeeded and both reported `verified: true`; the last
write won. Two different proposals pinned to the same revision, applied
simultaneously, behaved the same way. Applying the *same* proposal twice
concurrently was safe: exactly one succeeded, the other returned `conflict`.

This is the classic check-then-write race: Bludit exposes no conditional write,
so revision pinning prevents stale sequential overwrites but cannot serialise
simultaneous writers. The documentation's claim that pinning defeats
“approve a diff, then silently overwrite a newer edit” remains true for the
sequential case. If a stronger guarantee is wanted, the next step would be a
per-site write mutex in the MCP process; that is an architectural change and was
deliberately not made here.

## Integration results (real OpenCode session)

- `opencode mcp list` reports `bludit-wizard-mcp-stdio  connected` and
  `neon  connected`.
- The session's MCP tool catalogue exposed all 19 tools, and every one was invoked
  through that interface (not only through a standalone Node script).
- Invalid arguments were rejected by the tool schema with actionable messages;
  tool-level failures arrived as structured JSON with stable codes.
- A direct-vs-OpenCode comparison shows identical payloads for the same call; the
  only difference is error transport: the SDK returns `isError: true` with JSON
  text, while OpenCode surfaces it as a thrown error containing the same JSON.
- The OpenCode-managed server processes were started before the malformed-JSON fix
  was compiled. The fix was verified in a freshly spawned stdio process and in the
  test suite; it becomes active in a given OpenCode session when that session's MCP
  server is started or restarted (reload the session or restart OpenCode). Live
  functional results above are unaffected by this, because the defect only fires
  on a non-JSON upstream body.

## Failure testing

Expected errors observed: `invalid_input`, `not_found`, `revision_mismatch`,
`conflict`, `proposal_expired`, `site_auth_failed`, `site_unreachable`,
`upstream_error`. Every error carried a stable code, a human-readable message and
no credential or upstream body.

Unexpected behaviour observed once: immediately after an apply that created a page,
a follow-up read of that new key returned `404`; the page was present seconds later
and the MCP's own read-back inside the apply had succeeded. A direct create
followed immediately by a read succeeded on the first attempt (148 ms). This is
consistent with short-lived upstream/edge inconsistency on the disposable host and
was not reproducible. It is recorded as an observation, not a confirmed product
defect.

## Data integrity

- Published pages at the end: **3**, same keys, same revisions as at the start of
  the session, including `create-your-own-content` at
  `9a3d2ba320f549eb85a86b8f32c2b36862a511d21350165d2e3c3a8da9fec0e4`.
- Site settings unchanged (title `BLUDIT`, slogan, theme `alternative`,
  `itemsPerPage 6`).
- No page was published, deleted, or moved. All writes targeted session-created
  drafts, except where a deliberate negative test proved a write was refused.
- Temporary pages and final revisions are recorded in
  `docs/evidence/live-acceptance-2026-10-17.json`.
- Test pages remain on the disposable site, which the maintainer is deleting.

## Stability and restart

- 10 alternating sequential reads completed without error.
- Repeated capability calls reused the cache; `refresh: true` re-probed.
- Empty searches returned `count: 0` without error.
- After a failed read, the next read succeeded (no corrupted state).
- Local failure probes (500, redirect to private address, hang, oversized body,
  malformed JSON) all returned clean tool errors; the process stayed usable.
- Restart test with an isolated process: a proposal created in process 1 could not
  be applied in process 2 (`not_found`); the page itself persisted with unchanged
  content and revision; a new proposal could be created immediately afterwards.
  This matches decision D-0004 (proposals are in memory and do not survive a
  restart).

## Defect found and fixed

**Silent success on a non-JSON upstream body.**

- **Symptom:** a local HTTP fixture returning `200` with `{not json` was reported
  as `ok: true, count: 0, pages: []` — a false empty result.
- **Root cause:** `BluditClient.call()` used `response.json ?? {}`; a parse failure
  is `null`, which collapsed into an empty envelope.
- **Fix:** `assertJsonBody()` in `src/bludit/client.ts` now throws
  `upstream_error` for a non-empty body that is not JSON, on both the Bludit and
  Wizard paths. An empty body is still accepted, because some endpoints return
  none.
- **Tests:** two regression tests in `test/unit/bludit-client.test.ts` (non-JSON
  body rejected; empty body still accepted).
- **Verification:** the same live fixture now returns
  `upstream_error: "The Bludit site returned a response that is not valid JSON."`

## Automated regression suites

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 27 files, **438 passed**, 0 failed (includes the 2 new tests) |
| `npx playwright test` | **9 passed**, 0 failed |
| `npm pack --dry-run` | 50 files, package `bludit-wizard-mcp-0.1.0.tgz`, includes `dist/` and the `bin` entry |

Evidence files: `reports/junit.xml`, `reports/playwright-junit.xml`,
`docs/evidence/live-acceptance-2026-10-17.json`. Scratch probe scripts and raw
logs are under `/tmp/opencode/` and are not part of the repository.

Coverage by area (existing tests): MCP protocol and transport
(`test/local/stdio-edition.test.ts`, `stdio-process.test.ts`), configuration and
network safety (`test/local/config.test.ts`, `network-safety.test.ts`), the 19
tools (`test/integration/mcp-tools.test.ts`), error taxonomy and envelope handling
(`test/unit/bludit-client.test.ts`), proposals and revisions
(`test/unit/proposals.test.ts`), SSRF (`test/unit/ssrf.test.ts`), hosted OAuth and
audit (`test/integration/*`), and browser flows (`test/browser/`).

## Outstanding limitations

1. Concurrent writers pinned to the same revision are not serialised; last write
   wins. Sequential stale writes and replayed proposals are refused.
2. Proposals are process-local (D-0004) and vanish on restart.
3. No deletion tool by design.
4. Bludit slug derivation keeps punctuation and Unicode in page keys.
5. Bludit escapes HTML-like text and special characters on store, so raw input is
   not byte-identical on read-back.
6. `search_pages` with `include_content` refuses the default 200-page scan; the
   caller must pass `scan_limit <= 40`. This is deliberate (subrequest budget) but
   is a rough edge.
7. `get_website_settings` needs the user auth token; API-token-only installs are
   read-only for pages but cannot read settings.
8. The malformed-JSON fix is not yet loaded by the MCP processes of sessions that
   were already running; restarting the session/OpenCode applies it.
9. The Docker-backed live suite was not run in this session.
10. MCP client compatibility beyond OpenCode remains unverified; no other client
    was tested here.

## Naming and consolidation review (recommendation only — nothing renamed)

- Both directories are **worktrees of one repository**
  (`/home/evan/Projects/Bludit-Wizard-MCP` is the main worktree on
  `feat/remote-mcp-oauth-v1`; `-stdio` is a worktree on `feat/local-stdio-edition`).
- `main` (`73b5ddc`) is an ancestor of the stdio branch; the stdio branch is 23
  commits ahead and 0 behind. It contains the portable core, the local edition and
  the preserved Cloudflare transport. The legacy worktree adds no functionality
  the stdio branch lacks.
- Package name (`bludit-wizard-mcp`), binary (`bludit-wizard-mcp`) and product name
  (“Bludit Wizard MCP”) are already transport-neutral. The `-stdio` suffix is only
  a worktree directory label.
- **Cleanest path:** fast-forward `main` to `feat/local-stdio-edition`, move the
  working directory to the canonical path (or keep the main worktree), delete the
  temporary worktree with `git worktree remove`, and update only the absolute path
  in the OpenCode config. No package rename is needed; installation docs already
  use `npx bludit-wizard-mcp`.
- Nothing was renamed, merged or deleted in this session.

## Final recommendation

**READY FOR RELEASE REVIEW.** The tool surface is complete, the safety properties
hold, the automated suites pass, and the one correctness defect found is fixed and
covered by tests. Release itself remains blocked on the maintainer's separate
decisions (concurrency guarantee, deletion policy, publication) and on the
existing limitation that no MCP client beyond OpenCode has been verified.
