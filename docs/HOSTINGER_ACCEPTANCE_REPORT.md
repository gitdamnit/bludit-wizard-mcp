# Hostinger acceptance report — Bludit Wizard MCP v1.0.0

- **Test date:** 2026-10-23
- **Release under test:** Bludit Wizard MCP **v1.0.0**
  (`https://github.com/gitdamnit/bludit-wizard-mcp/releases/tag/v1.0.0`)
- **Package:** `bludit-wizard-mcp-1.0.0.tgz`
- **Expected and verified SHA-256:**
  `4b0d1979f2be98f6937a3b68af19f9b18537ee26680ae048d643bc8b0dcf87e5`
- **Install method:** downloaded from the GitHub release, installed with
  `npm install --prefix` into a clean temporary directory, used from there. The
  local development build was not used.
- **Site:** `https://lightsalmon-caribou-519069.hostingersite.com`
- **Native Bludit Wizard PHP plugin:** not installed, not required and not used
  (`wizardExtensionDetected: false`).

## Overall outcome

**BLOCKED for the fresh-installation write acceptance. Package verification and
read-only acceptance PASS.**

The release package is correct and installable, all nineteen tools are advertised,
and every non-mutating path works against the configured Hostinger site. However,
the site currently configured is **the previous disposable demo from the earlier
acceptance run**, not a newly created installation: it still contains the earlier
`BW-ACC-20261017-2115-*` and `mcp-integration-test` fixtures. Per the test brief,
the fresh-site write workflow (`create_page`, `edit_page`, valid applies, replay)
was therefore **not executed**, so the production-like acceptance criteria for
writes are not met.

No content was created, edited or deleted on the site during this test. The
published page revision was `9a3d2ba3…` before and after all operations.

## Environment

| | |
|---|---|
| Host | `lightsalmon-caribou-519069.hostingersite.com` |
| Bludit identification | `x-powered-by: Bludit`, `<meta name="generator" content="Bludit">` |
| Bludit version | **Not disclosed** by the site or its API; no version endpoint exists |
| PHP version | **Not disclosed**; the host returns `server: hcdn` |
| API plugin | Enabled and reachable: `pages`, `settings`, `tags`, `categories`, `users`, `files`, `images`, `search` |
| Reads | `reachable: true`, `readOk: true` |
| Authenticated calls | `authenticatedOk: true` |
| Site content fingerprint | 3 published + 10 draft pages, including the earlier acceptance fixtures |
| Credentials | Supplied through the existing local OpenCode MCP environment; never printed, logged, reported or committed |

### Why this is not a fresh installation

The site returned the fixtures created by the previous acceptance run, for example
`bw-acc-20261017-2115-a` through `-h`, `bw-acc-20261017-2115-a-0` and
`mcp-integration-test-—-temporary`. A fresh installation would not contain them.
The site is disposable, but it is not new, so it cannot satisfy the “fresh,
disposable Hostinger installation” premise of this task.

## Published-package verification

| Check | Result |
|---|---|
| Download from GitHub release | Pass |
| SHA-256 matches the published checksum | Pass (`4b0d19…f87e5`) |
| Clean `npm install --prefix` | Pass |
| `bludit-wizard-mcp --version` | `1.0.0` |
| Package metadata | `bludit-wizard-mcp` 1.0.0, `GPL-3.0-only`, `bin.bludit-wizard-mcp` present |
| MCP `initialize` | Pass; `serverInfo` 1.0.0 |
| `tools/list` | **19** tools |
| Deletion tool present | **No** |
| Unrelated MCP server required | No; a standalone stdio client was sufficient |

## Nineteen-tool coverage matrix

| # | Tool | Status | Evidence / notes |
|---|---|---|---|
| 1 | `list_sites` | **PASS** | One connected site; id `local`, status `connected` |
| 2 | `select_site` | **PASS** | Hostname resolved; unknown reference returned `not_found` |
| 3 | `get_site_capabilities` | **PASS** | API reachable and authenticated; edition reported `unknown`, as documented |
| 4 | `get_website_settings` | **PASS** | Title `BLUDIT`, theme `alternative`, URLs present |
| 5 | `list_pages` | **PASS** | 3 published, 13 with drafts, pagination consistent |
| 6 | `get_page` | **PASS** | Known page returned content and revision; unknown key returned `not_found` |
| 7 | `get_drafts` | **PASS** | 10 drafts returned |
| 8 | `get_scheduled_pages` | **PASS** | Accurate empty list |
| 9 | `list_categories` | **PASS** | `general`, `music`, `videos` |
| 10 | `list_tags` | **PASS** | 0 tags; accurate empty result |
| 11 | `search_pages` | **PASS** | Exact title 1 match, absent term 0, draft scan 9 matches; empty query rejected |
| 12 | `get_content_summary` | **PASS** | Deterministic stats, headings and warnings for a real page |
| 13 | `get_related_pages` | **PASS** | 3 related pages with reasons; no fabricated keys |
| 14 | `create_page` | **BLOCKED** | Valid create not run (no fresh site). Unauthorized create refused with `site_auth_failed`; no page created |
| 15 | `edit_page` | **BLOCKED** | Valid edit not run (no fresh site). Stale revision refused with `revision_mismatch`; revision unchanged |
| 16 | `propose_page_edit` | **PASS** | Proposal created, pinned to `9a3d2ba3…`; page revision unchanged |
| 17 | `preview_page_changes` | **PASS** | `wouldChange: true`; page revision unchanged |
| 18 | `apply_approved_edit` | **BLOCKED** | Valid apply and replay not run (no fresh site). Unknown id → `not_found`; expired proposal → `proposal_expired`; no write |
| 19 | `verify_page_update` | **PASS** | Correct expectations passed; wrong revision and absent content reported `ok: false` field by field |

## Read-only results

- 3 published pages; 13 total with drafts; 10 drafts; 0 scheduled; 3 categories;
  0 tags.
- `get_page("create-your-own-content")` returned revision
  `9a3d2ba320f549eb85a86b8f32c2b36862a511d21350165d2e3c3a8da9fec0e4`,
  title `Create your own content`, type `published`.
- `search_pages("Create your own content")` found exactly that page; an absent
  term returned 0; draft-aware search for `BW-ACC` found 9 fixtures.
- `get_content_summary` produced deterministic counts and warnings consistent with
  the page being a single short paragraph with no headings.
- All tool responses came from the configured site; no other site was contacted.

## Controlled-write results

**Not executed against the configured site.** Reasons and evidence:

- The configured site is the previous demo, not the fresh installation required by
  the brief (13 pages, prior fixtures present).
- No `create_page`, valid `edit_page`, or valid `apply_approved_edit` call was made.
- The only write-shaped calls were deliberate refusals:
  - create with no user auth token → `site_auth_failed` before any request that
    would write;
  - edit with a stale revision → `revision_mismatch` before the PUT;
  - apply unknown proposal → `not_found`; apply expired proposal →
    `proposal_expired`.
- A subsequent full draft listing confirmed that none of the refused titles exist
  (`BW-V100-NOAUTH-MUST-NOT-EXIST`, “MUST NOT LAND”, “PROPOSED ONLY”).
- The published page revision was identical before and after all tests.

Consequently, the following required checks remain unverified on v1.0.0:

- Create → read → propose → preview → apply → verify with real persisted content.
- Direct edit with a valid expected revision.
- Applying a valid approved proposal and reading the change back.
- Replay refusal after a real successful apply.
- Proposal isolation between unrelated pages, which needs two successful applies.

## Approval-model results

| Property | Result |
|---|---|
| Proposal creation does not modify the page | **PASS** — revision unchanged |
| Preview does not modify the page | **PASS** — revision unchanged |
| Proposal is pinned to the current revision | **PASS** — `baseRevision` matched `get_page` |
| Stale revision refusal | **PASS** — `revision_mismatch`, no write |
| Unknown proposal refusal | **PASS** — `not_found` |
| Expired proposal refusal | **PASS** — isolated zero-TTL fixture returned `proposal_expired` |
| Valid apply updates the intended page | **BLOCKED** — requires the fresh site |
| Replay of a successful proposal is refused | **BLOCKED** — requires a successful apply first |
| Approval state isolated between pages | **BLOCKED** — requires successful applies |

Concurrency limitation remains as documented: revision pinning does not serialise
two simultaneous independent writers; Bludit has no conditional write. This test did
not claim atomic multi-process protection.

## Security and negative results

| Probe | Result |
|---|---|
| Invalid API token | `site_auth_failed` |
| Missing API token | Process refused to start |
| Missing auth token on write | `site_auth_failed`, no write |
| Stale revision | `revision_mismatch` |
| Unknown proposal id | `not_found` |
| Expired proposal | `proposal_expired` |
| Invalid enum / missing required parameter | Rejected by the MCP schema |
| Loopback and `localhost` URLs | Rejected unless the development flag is set |
| Private / link-local / metadata addresses | Rejected |
| Non-HTTPS scheme, malformed URL, embedded credentials | Rejected |
| Redirect to `169.254.169.254` | `invalid_input` |
| Malformed JSON with HTTP 200 | `upstream_error` |
| HTTP 500 | `upstream_error` |
| Hanging upstream | `site_unreachable` after the 12 s timeout |
| 3 MiB response | `site_unreachable` (“response exceeded the maximum accepted size”) |
| Credentials in tool responses / stderr audit lines | None found |

Hostile network probes were run only against local fixtures, never against
Hostinger. The site received only normal read calls and refused-write checks.

## Limitations and classification

| Finding | Classification |
|---|---|
| Write acceptance not executed | **Test-fixture problem** — no fresh site provided; not an MCP defect |
| Configured site contains previous fixtures | **Configuration/precondition** — wrong test target for this brief |
| Bludit version / PHP version unavailable | **Hosting/API limitation** — not exposed by Bludit or the host |
| Replay and cross-page proposal isolation unverified on v1.0.0 | Consequence of the blocked write workflow; prior v0.1.0 acceptance evidence exists but is not silently reused as v1.0.0 evidence |
| Multi-writer race | Documented product limitation, unchanged |

No MCP server defect was found in this run.

## Required steps to complete the acceptance

1. Create a fresh disposable Bludit 3.22.x installation on Hostinger; do not reuse
   the previous demo or any production site.
2. In Bludit, enable **Admin → Plugins → API** and copy the **API token**.
3. Copy the admin **user auth token** from **Admin → Users → your user → Security**.
4. Provide the three values without pasting them into chat or Git. Either:
   - set `BLUDIT_URL`, `BLUDIT_API_TOKEN`, `BLUDIT_AUTH_TOKEN` in the acceptance
     shell environment, or
   - write a JSON file readable only by the maintainer, for example
     `~/.config/bludit-wizard-mcp/hostinger-acceptance.json` with
     `{"BLUDIT_URL":"…","BLUDIT_API_TOKEN":"…","BLUDIT_AUTH_TOKEN":"…"}` and
     `chmod 600` it, then provide only the file path.
5. Re-run the acceptance against that site. The write phase will then exercise
   `create_page`, `edit_page`, `propose_page_edit`, `preview_page_changes`,
   `apply_approved_edit` (valid, replay, stale) and `verify_page_update` on new
   draft fixtures only.

The existing OpenCode MCP configuration was not modified, the released tag and
binary were not changed, and no further release was published.
