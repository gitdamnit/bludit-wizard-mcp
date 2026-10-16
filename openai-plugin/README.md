# OpenAI plugin package — prepared, not submitted

This directory holds a ready-to-complete package for submission to the OpenAI
plugin directory. **It has not been submitted, and it is not submittable as it
stands.** The blocking items are listed below.

The structure follows OpenAI's current documentation, read on 2026-10-16:

- <https://developers.openai.com/plugins/deploy/submission>
- <https://developers.openai.com/plugins/build/plugins>
- <https://developers.openai.com/plugins/plugin-guidelines>

## Contents

| File | Purpose |
|---|---|
| `plugin.json` | Agent Plugins manifest: package identity, listing text, review and publication metadata |
| `mcp.json` | The single remote MCP server this plugin connects to |
| `skills/get-started/SKILL.md` | Onboarding skill: how a user connects their first site |

Icons and screenshots are **not** included. OpenAI requires a square logo of at
least 48×48 px (PNG, JPEG, WebP or SVG, ≤ 5 MiB) plus a composer icon, and a
primary app icon is required before submission. No image is committed here
because none has been designed yet; the manifest therefore omits `logo`,
`composerIcon` and `screenshots`, and the upload will warn about the missing
icon until they are added.

## Blocking items

Everything here must be true before the ZIP can be submitted.

| # | Item | Status |
|---|---|---|
| 1 | A deployed MCP server at a stable public HTTPS endpoint | ❌ Not deployed |
| 2 | `AUTH_ISSUER` and `MCP_RESOURCE` set to the real hostnames | ❌ still `localhost` in the deployable configs |
| 3 | `https://<host>/.well-known/openai-apps-challenge` serving the exact challenge token as plain text | ❌ Not implemented |
| 4 | A verified developer identity in the OpenAI organization | ❌ |
| 5 | A live website URL | ❌ `https://example.com` placeholders |
| 6 | A live support URL | ❌ |
| 7 | A live privacy policy URL | ❌ |
| 8 | A live terms-of-service URL | ❌ |
| 9 | A square logo, at least 48×48 px, plus a composer icon | ❌ |
| 10 | Five positive review test cases | ❌ empty in `plugin.json` |
| 11 | Three negative review test cases | ❌ empty in `plugin.json` |
| 12 | A demo video walkthrough URL | ❌ |
| 13 | A dedicated reviewer test account that works without MFA, email codes, magic links or private-network access | ❌ |
| 14 | At least one connected Bludit site with disposable sample content for the test account | ❌ |

Items 1–3 depend on a deployment, which requires explicit approval
(`docs/DEPLOYMENT.md`). Items 5–8 depend on the portfolio site, a separate
project objective.

## Fields that must be replaced

`plugin.json` uses `https://example.com` in six places and an unverified
repository URL. Replace:

- `author.url`
- `homepage`
- `repository`
- `extensions.com.openai.interface.websiteURL`
- `extensions.com.openai.interface.supportURL`
- `extensions.com.openai.interface.privacyPolicyURL`
- `extensions.com.openai.interface.termsOfServiceURL`

All four `interface` URLs are required for a public review of an MCP-connected
plugin, must be HTTPS, and must not contain embedded credentials.

`mcp.json` points at the planned production endpoint,
`https://mcp.evanzellner.com/mcp`. Confirm or change it to match `MCP_RESOURCE`.

## Submission notes

### One MCP server per plugin

OpenAI allows exactly one connected MCP server per plugin. This plugin declares
one, which is the whole product.

### Authentication

The server implements OAuth 2.1 with full discovery: RFC 9728
protected-resource metadata names the authorization server, and RFC 8414
metadata names the authorization, token and registration endpoints. So
`mcp.json` needs only the URL — no `authorizationUrl` or `tokenUrl` overrides.

Both registration methods OpenAI supports are available:

- **CIMD** (preferred): the server sets `clientIdMetadataDocumentEnabled`, so a
  URL-shaped client ID is resolved to a metadata document the client controls.
  This requires the `global_fetch_strictly_public` compatibility flag, which the
  production configs set.
- **DCR**: `/oauth/register` is advertised for older clients.

A registered client is possible too, but there is no reason for it here.

Do **not** put a client secret in `mcp.json`: the manifest rejects
`clientSecret`, and the value belongs in the portal when it is required.

Confirm the exact `mcp.json` authentication keys against the
[MCP authentication reference](https://developers.openai.com/plugins/build/plugins)
before submitting — this package deliberately declares only `type` and `url`
rather than guessing key names.

### Domain verification

OpenAI requires the exact challenge token, as plain text and nothing else, at:

```
https://<challenge-base-host>/.well-known/openai-apps-challenge
```

The base must be an HTTPS origin on the MCP hostname or an eligible parent
domain. This is not implemented yet. It belongs in the MCP resource server as a
static route, and the token itself must be entered in the Cloudflare dashboard
rather than committed.

### Reviewer credentials

The review team is given a dedicated test account and can only use it if sign-in
needs no second factor, no email or SMS code, no magic link, and no
private-network access. This server's sign-in is email and password only, which
satisfies that — provided the reviewer account is created with a password and
`ALLOW_SIGNUP` is left as it is. The test account must have at least one
connected Bludit site, with disposable sample content, that works immediately.

Reviewer credentials are entered in the portal's **Review details**, never in the
ZIP.

### Review test cases

Five positive and three negative cases are required, each with the scenario, the
prompt, the tools expected to run, and the expected result. Drafts, ready to paste
in, along with the demo-video script, are in
`docs/OPENAI_PUBLICATION_CHECKLIST.md`.

`plugin.json` leaves `review.test_cases` empty on purpose: populating it with
cases that have not been run against a live deployment would be a false claim, and
OpenAI requires each case to be run with the test account before submitting.

### Lifecycle hooks and app references

OpenAI rejects packages containing `apps` / `.app.json` references or lifecycle
hooks. This package has neither — it is a manifest, an MCP configuration and one
skill.

### Updates after publication

MCP tool changes are picked up by a daily scan of the server; no new ZIP is
needed. Changes to metadata or skills do need a new ZIP. Keep the server
compatible with the currently approved tool schemas during an update.

## Building the ZIP

The ZIP must contain the package contents at its root, including every file the
manifest references.

```bash
cd openai-plugin
zip -r ../bludit-wizard-mcp-openai-plugin.zip . \
  -x '.DS_Store' '*/.*'
```

Then, in the portal: **Plugins → Upload new or existing plugin**, choose the
verified developer identity, upload, resolve findings, connect the MCP server
and complete domain verification, fill in **Review details**, and submit.

Nothing in this repository uploads anything.
