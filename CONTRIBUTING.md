# Contributing

## Contents

- [Getting set up](#getting-set-up)
- [Before you open a pull request](#before-you-open-a-pull-request)
- [The two rules](#the-two-rules)
- [Where things live](#where-things-live)
- [Adding a tool](#adding-a-tool)
- [Code style](#code-style)
- [Security](#security)

## Getting set up

```bash
git clone <this repo>
cd bludit-wizard-mcp
npm ci
npm run typecheck
npm test
```

`.npmrc` sets `legacy-peer-deps=true` to work around an npm 10.9.x crash while
resolving vitest's peer set. The reason and how to remove it are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#the-legacy-peer-deps-flag).

To run the Workers locally you need a `.dev.vars`; copy `.dev.vars.example` and
generate the three secrets as described there.

## Before you open a pull request

```bash
npm run typecheck        # must be clean; there is no "known errors" list
npm test                 # 324 hermetic tests, currently all green
npm run test:browser     # 9 browser tests
npm run build:auth && npm run build:mcp   # both Workers must bundle
```

A change is not ready while any of those fails. If a test is genuinely wrong,
fix the test in the same commit and say why in the message.

If your change touches the Bludit client — anything in `src/bludit/`, or the field
handling in `src/mcp/tools/` — run the live suite as well:

```bash
PRO_ZIP=/path/to/bludit-pro-3.22.0.zip scripts/live-bludit-up.sh both
npm run test:live
scripts/live-bludit-up.sh --down
```

It is what found that Bludit sends `tags` as a comma-joined string and `category`
as `false`, neither of which the mock had right, and it takes about two minutes.

## The two rules

Everything else here is normal engineering judgement. These two are not.

### 1. Never claim something works that has not been tested

This applies to documentation, comments, commit messages, tool descriptions and
pull request descriptions.

Say "verified against X on date Y", or say "not verified". Do not write "works
with ChatGPT", "compatible with Bludit Community", or "supports Cursor" unless
someone has actually connected that client, or that edition, and recorded the
result. The compatibility documents exist to make the honest answer easy:
[docs/CLIENT_COMPATIBILITY.md](docs/CLIENT_COMPATIBILITY.md),
[docs/BLUDIT_COMPATIBILITY_MATRIX.md](docs/BLUDIT_COMPATIBILITY_MATRIX.md).

Related: do not weaken a test to make it pass, and do not present a mock as a live
system. The mock Bludit server exists so CMS behaviour can be tested at all; it is
labelled as a mock everywhere.

### 2. Never merge upstream silently

`upstream` points at `bludit/bludit-mcp`, pinned at
`73b5ddcb92015d1359370ba2613090eef6af910c`. Upstream is never pulled
automatically.

To consider an upstream change:

```bash
git fetch upstream
git log --oneline HEAD..upstream/main
git diff HEAD...upstream/main
```

Decide per commit, record the decision and the new pin in
[docs/UPSTREAM_COMPARISON.md](docs/UPSTREAM_COMPARISON.md), and make it its own
commit. A wholesale merge would reintroduce `delete_page` and the
startup-settings fetch, both of which were removed on purpose.

Preserve attribution: upstream code stays upstream code, and the MIT notice in
`LICENSE` is not to be edited except to add a copyright line.

## Where things live

| Path | What |
|---|---|
| `src/shared/` | Crypto, SSRF policy, errors, logging, scopes, cookies, HTML — no CMS or Workers-specific assumptions where it can be avoided |
| `src/bludit/` | The Bludit HTTP client and capability detection |
| `src/sites/` | Site registry, encrypted credentials, pairing, the connection flow |
| `src/proposals/` | Proposal records and deterministic change previews |
| `src/auth/` | Authorization server: accounts, sessions, consent, site UI, the OAuth library wiring |
| `src/mcp/` | Resource server: routing, the MCP server, and one module per tool group |
| `migrations/` | D1 schema, additive only |
| `test/unit/` | Pure logic, Node environment, fast |
| `test/integration/` | Two Workers in workerd via `createTestHarness`, with a real Service Binding |
| `test/compat/` | Modelled Bludit variants; writes `reports/bludit-compatibility.json` |
| `test/live/` | Real Bludit Community and Pro in containers. Opt-in, separate config, skips without credentials |
| `test/harness/` | The mock Bludit server, the OAuth client, the schema worker |
| `docs/` | Everything above |

Prefer small, independently testable modules. Several modules exist purely
because their logic needed to be testable without a binding or a Worker
(`write-helpers.ts`, `registry-helpers.ts`, `routing.ts`, `redirect.ts`).

## Adding a tool

1. **Decide whether it should exist.** Do not add a tool to increase the count.
   If it is a deterministic transformation, say so in its description. If it
   would require inference, leave that to the client rather than adding a model
   dependency — this project has none, and should keep none.
2. **Add it to `TOOL_SCOPES`** in `src/shared/scopes.ts`. That single map drives
   enforcement, the `403` challenge and the documentation.
3. **Check the capability first.** Does the Bludit API support it? If only the
   optional Wizard extension does, it belongs behind
   `get_site_capabilities`, and the missing case must degrade cleanly.
4. **Declare `title`, `description` and all four `annotations`.** `readOnlyHint`,
   `destructiveHint`, `idempotentHint`, `openWorldHint`. Clients use these.
5. **Validate server-side.** `pickWriteFields` and `assertWritable` for writes.
   Never trust a shape just because Zod accepted it.
6. **Return the structured result**, `ok(...)` / `toResult(...)`, with a stable
   error code from `src/shared/errors.ts`. No credential, token, upstream body or
   URL-with-token may appear in an error.
7. **Audit it.** Wrap the body in `withAudit(ctx, '<tool name>', …)`.
8. **Test it positively and negatively.** A test that it works, and a test that it
   refuses the wrong thing. The negative test is usually the more valuable one.
9. **Document it** in `docs/MCP_TOOLS.md`, with its scopes and its kind.

Write tools additionally need: a verified read-back, a revision check where the
operation could race, and a note in `docs/SECURITY.md` if they change the risk
profile.

## Code style

- TypeScript, strict, `noUncheckedIndexedAccess`. No `any` without a reason in a
  comment. No non-null assertions on anything that could actually be null.
- Comments explain **why**. The code says what it does; a comment that restates
  it is noise. Comments that record a non-obvious constraint — a Bludit quirk, a
  platform limit, a security reasoning step — are the valuable kind, and there are
  many here on purpose.
- Prefer an explicit error over a silent fallback. `search_pages` refusing a
  200-page content scan is better than failing halfway through.
- Never sanitise Bludit input. Bludit sanitises DB-bound values itself, and doing
  it again double-encodes (`Cats & Dogs` becomes `Cats &amp;amp; Dogs`). Validate;
  do not sanitise.
- No new runtime dependency without a reason. WebCrypto rather than a crypto
  package, for instance, so the same code runs in workerd and in Node under test.

## Security

Do not open a public issue for a vulnerability — see
[docs/SECURITY.md](docs/SECURITY.md) for how to report one privately.

If your change touches any of these, expect a closer review and say so in the
pull request:

- `src/shared/ssrf.ts`, `src/shared/crypto.ts`, `src/auth/`
- anything that reads, writes, logs, returns or compares a credential
- scope enforcement, `src/mcp/app.ts`
- `migrations/`

Never commit a real credential, a `.dev.vars`, a `.env`, a token, a hostname you
do not own, or a screenshot containing a token field.
