# Bludit compatibility matrix

## Read this first

**Every result below is mock-verified, not live-verified.** The MCP server was
tested against a faithful re-implementation of the Bludit 3.22.x HTTP API
(`test/harness/mock-bludit.ts`), written from the shipped API plugin source. No
live Bludit installation — Community or Pro — has been connected to this server.

That distinction matters, so it is stated in every table.

## What the mock is based on

| | |
|---|---|
| Package | `bludit-pro-3.22.0-20260510.zip` |
| Build | Bludit PRO 3.22.0, build 20260510 |
| Build commit | `d5612ed979eeb9ac222a2272aab0c8b97cc09826` |
| Built | 2026-05-14 16:47:31 UTC |
| Source read | `bl-plugins/api/plugin.php` (911 lines), `bl-kernel/pages.class.php`, `bl-kernel/pagex.class.php`, `bl-kernel/functions.php` |
| Consumer | `wizard/plugin.php` from `bludit-wizard-1.0.4-rc1.zip`, which declares `compatible: "3.22"` |

The mock reproduces the behaviours that matter: token placement per HTTP method,
the `{status:"0"|"1"}` envelope alongside real HTTP status codes, the `type`
filters, `numberOfItems: -1`, out-of-range pagination, and the fact that changing
a page's slug moves it and therefore changes its key.

## An assumption that has not been verified

**Bludit Community 3.22.x is assumed to ship the same `bl-plugins/api` as Pro
3.22.x.** That assumption was **not** verified: only the Pro build was available
for inspection. No Community package was examined, and no live Community site was
tested.

If Community's API plugin differs — a missing endpoint, a different envelope, a
different default `numberOfItems` — the Community rows below would change. The
tool surface is deliberately built so that a difference in capability shows up in
`get_site_capabilities` rather than as a crash, but that is a design mitigation,
not evidence.

Confirming this requires one live Community install and one live Pro install. It
is the single highest-value outstanding verification task for this project.

## Variants tested

| # | Variant | Edition | Version | Wizard extension | API plugin |
|---|---|---|---|---|---|
| 1 | `community-3.22.0` | Community | 3.22.0 | absent | enabled |
| 2 | `pro-3.22.0` | Pro | 3.22.0 | absent | enabled |
| 3 | `pro-3.22.2` | Pro | 3.22.2 (patch) | absent | enabled |
| 4 | `pro-3.22.0-wizard` | Pro | 3.22.0 | **present** | enabled |
| 5 | `community-api-disabled` | Community | 3.22.0 | absent | **disabled** |

Variants 1–4 differ only in the modelled API surface each represents. Variant 5
models a site where the administrator has not enabled the API plugin, which is the
most common misconfiguration.

Variants 3 models a later patch of the same line, to check that nothing in this
server depends on version-specific behaviour. The API plugin's surface is
identical across 3.22.x as far as the shipped builds show; this is asserted rather
than assumed.

## Results

Measured by `test/compat/bludit-editions.test.ts`. Every run writes
`reports/bludit-compatibility.json` (git-ignored build output); a copy of the run
below is committed at
[`docs/evidence/bludit-compatibility.json`](evidence/bludit-compatibility.json)
so the table can be checked against its source. Generated 2026-10-16.

`declared` is what the site owner entered when connecting the site. `detected` is
what this server could verify independently.

| | 1 community-3.22.0 | 2 pro-3.22.0 | 3 pro-3.22.2 | 4 pro-3.22.0-wizard | 5 community-api-disabled |
|---|---|---|---|---|---|
| Declared edition recorded | community | pro | pro | pro | community |
| Detected edition | unknown | unknown | unknown | unknown | unknown |
| Capability: read OK | ✅ | ✅ | ✅ | ✅ | ❌ |
| Capability: authenticated OK | ✅ | ✅ | ✅ | ✅ | ❌ |
| Wizard extension detected | ❌ | ❌ | ❌ | ✅ | ❌ |
| `list_pages` | success | success | success | success | `capability_unavailable` |
| `get_page` | success | success | success | success | `not_found` |
| `create_page` | success | success | success | success | `capability_unavailable` |
| `edit_page` | success | success | success | success | `not_found` |
| `propose_page_edit` + `apply_approved_edit` | success | success | success | success | `not_found` |
| Verification | mock | mock | mock | mock | mock |
| Live confirmation | **pending** | **pending** | **pending** | **pending** | **pending** |

## Confirmed differences

### Community vs Pro: none observed

For the same API surface, this server behaves identically on both editions. The
only difference in the table is the edition the user declared. A test asserts this
equality explicitly, so no feature is accidentally restricted to one edition.

This is the expected result given that Pro 3.22.x ships the same API plugin, but
it rests on the unverified assumption above.

### With vs without the Wizard extension: one capability, no behaviour change

Variant 4 differs from variant 2 in exactly one cell: the Wizard extension is
detected. Every tool produces the same outcome. The extension is additive — it
improves the site-connection proof and is reported by
`get_site_capabilities`, and nothing in the core tool set depends on it.

### API plugin disabled: actionable errors, not opaque failures

Variant 5 is where the error handling earns its keep:

| Call | Error code | Why that code |
|---|---|---|
| `list_pages` | `capability_unavailable` | A 404 on `/api/pages` means the plugin is off, not that a page is missing |
| `create_page` | `capability_unavailable` | Same reason |
| `edit_page` | `not_found` | Bludit returns 404 for a missing page, and the plugin's absence is indistinguishable from a missing page on that path |
| `get_page` | `not_found` | Genuinely "no such page" |
| `get_site_capabilities` | reports `reachable: false` with the reason | The point of the tool |

A reviewer should note the honest asymmetry: `list_pages` and `create_page` can
tell the two cases apart because those endpoints only exist when the plugin is
enabled, while `edit_page` and `get_page` cannot, and therefore report `not_found`.
`get_site_capabilities` is the tool that resolves the ambiguity, which is why it
exists.

## Version coverage

| Version | Status |
|---|---|
| 3.22.0 | Modelled from the shipped Pro build; mock-verified |
| 3.22.x (later patches) | Modelled as behaviourally identical; mock-verified |
| 3.22.x Community | **Assumed** identical to Pro; unverified |
| Earlier than 3.22 | **Not supported.** The Wizard plugin declares `compatible: "3.22"`, and the API plugin surface this server targets is the 3.22 line. |
| Later than 3.22 | Unknown. `get_site_capabilities` will report what it finds rather than assuming. |

## Operation coverage

| Operation | Covered | Notes |
|---|---|---|
| Read site settings | ✅ | Requires an authenticated admin token; Bludit's own rule |
| List / read pages | ✅ | Including drafts and scheduled pages |
| Create page | ✅ | Including key derivation from the slug |
| Edit page | ✅ | Including key change on slug change |
| Propose + apply an edit | ✅ | Including stale-approval rejection |
| Read tags and categories | ✅ | Official API only; the Wizard API has no equivalent |
| Search | ✅ | Server-side only; Bludit has no search endpoint |
| Create a **draft** specifically | ✅ | `type: "draft"` on create |
| Image / file upload | ⚠️ **Not exposed** | The API supports it; no tool does. Out of scope, and no test |
| Delete page | ⚠️ **Not exposed** | Policy decision, see `SECURITY.md` |
| Edit site settings | ⚠️ **Not exposed** | The API supports `PUT /api/settings`; no tool does |
| User listing | ⚠️ **Not exposed** | The API supports it; no tool does, and it is not even probed |
| Install / upgrade / uninstall of the PHP plugin | ⚠️ **Not tested** | The plugin is not modified or installed by this project. Its `metadata.json` declares `compatible: "3.22"`; installation behaviour is the PHP project's own concern |
| Custom fields (`custom`) | ⚠️ **Not exposed** | Readable through the API's page JSON; no tool surfaces them |

## Limitations of this matrix

1. **No live installation was connected.** The mock is a re-implementation. A
   mock can agree with a misreading of the source.
2. **The Community plugin source was not inspected.**
3. **The PHP Wizard plugin was inspected at version 1.0.4-rc1**, which its own
   metadata labels as a release candidate pending live validation. Its
   `/api/wizard/*` behaviour is modelled from source, not observed.
4. **The pairing endpoint `/api/wizard/pair` does not exist in PHP.** It is a
   proposal in `PHP_WIZARD_INTEGRATION.md`. The Wizard pairing path is tested
   against the mock's implementation of that proposed contract, so the test proves
   the MCP side, not the PHP side.
5. **Edition and version detection is not possible over HTTP.** Bludit exposes no
   version or edition endpoint, so `detected` is always `unknown` and
   `declared` is self-reported. This matrix therefore describes *modelled*
   editions, not identified ones.
6. **Only 3.22.x is in scope.** Nothing here claims support outside that line.

## How to close the gaps

To turn this into a live-verified matrix:

1. Stand up a disposable Bludit Community 3.22.x and a disposable Bludit Pro
   3.22.x, with different credentials.
2. Connect each to a development deployment of this service.
3. Run the same operation set as `test/compat/bludit-editions.test.ts` against
   each, and record the results in a `live-verified` column.
4. Diff the two editions' `get_site_capabilities` output. That is where a real
   API-plugin difference would appear first.
5. Install the Wizard plugin on one of them and repeat, to confirm the pairing
   contract once it exists in PHP.

Credentials for those sites must come through a secure configuration mechanism,
must not be committed, and must not appear in any test log or report.
