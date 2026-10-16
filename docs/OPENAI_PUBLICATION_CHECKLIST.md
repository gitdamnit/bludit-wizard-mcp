# OpenAI publication readiness checklist

**Nothing has been submitted.** This is the preparation, with the remaining
manual steps listed explicitly.

Requirements were read from OpenAI's current documentation on 2026-10-16:

- <https://developers.openai.com/plugins/deploy/submission> — upload, connect,
  review, publish
- <https://developers.openai.com/plugins/build/plugins> — package and manifest
  fields, MCP authentication
- <https://developers.openai.com/plugins/plugin-guidelines> — referenced but not
  yet read; see "Not yet reviewed" below

## Readiness summary

| Area | Ready | Blocked on |
|---|---|---|
| Plugin package structure | ✅ | — |
| Manifest metadata and listing text | ✅ | placeholder URLs |
| MCP server implementation | ✅ | not deployed |
| Rate limiting on every public entry point | ✅ | — |
| OAuth (CIMD + DCR) | ✅ | not deployed |
| Domain-verification route | ❌ | not implemented; needs a deployment |
| Privacy policy, support, terms | ❌ | portfolio site (separate objective) |
| Icons and screenshots | ❌ | no artwork yet |
| Reviewer test cases | 📝 drafted below | must be run against a live deployment |
| Reviewer demo account | ❌ | needs a deployment and a disposable site |
| Demo video | ❌ | needs a deployment |
| Policy attestations | ❌ | human decision |

## 1. Package

- [x] `openai-plugin/plugin.json` — Agent Plugins manifest
- [x] Rate limiting configured and verified (a review team will probe for it)
- [x] `openai-plugin/mcp.json` — one remote MCP server, `streamable-http`
- [x] `openai-plugin/skills/get-started/SKILL.md` — onboarding skill with a valid
      `name` and `description` in its YAML header
- [x] No `apps` / `.app.json` references and no lifecycle hooks (both are rejected
      for public submission)
- [x] No credentials of any kind in the package
- [ ] Replace the seven `https://example.com` values with live HTTPS URLs
- [ ] Add a square logo, ≥ 48×48 px, and a composer icon (PNG/JPEG/WebP/SVG, ≤ 5 MiB)
- [ ] Add screenshots (optional, but the listing is better with them)
- [ ] Build the ZIP with all referenced files at its root

## 2. Deployment prerequisites

- [ ] Deploy both Workers to real hostnames (`docs/DEPLOYMENT.md`)
- [ ] Set `AUTH_ISSUER` and `MCP_RESOURCE` to those hostnames in both configs
- [ ] Confirm `.well-known/oauth-authorization-server` reports
      `client_id_metadata_document_supported: true`
- [ ] Confirm `.well-known/oauth-protected-resource` names the same issuer
- [ ] Confirm a fresh OAuth client can authorize end to end against the deployed
      service
- [ ] Connect one disposable Bludit site with sample content for the review account

## 3. Domain verification

OpenAI shows a challenge token in the portal. It must be served as **exact plain
text and nothing else** at:

```
https://<challenge-base-host>/.well-known/openai-apps-challenge
```

The base must be an HTTPS origin on the MCP hostname or an eligible parent domain;
paths are ignored.

- [ ] Implement the route in the MCP resource server, serving the token from an
      environment variable, never committed
- [ ] Verify with `curl -s https://<host>/.well-known/openai-apps-challenge` that
      the output is the token alone, with no JSON, no quotes and no trailing list
- [ ] Check for a collision: if another plugin already uses this URL, use an
      eligible parent origin or a distinct hostname

## 4. Authentication

The server implements both registration methods OpenAI supports, and full
discovery, so `mcp.json` needs only the URL.

- [x] Streamable HTTP at a stable public HTTPS endpoint
- [x] OAuth 2.1 Authorization Code with PKCE (S256 required)
- [x] CIMD preference and a DCR fallback (`/oauth/register`)
- [x] Discovery provides authorization, token and registration endpoints, so no
      `authorizationUrl` / `tokenUrl` overrides are needed
- [x] No API-key or bearer-token flow, which OpenAI's portal cannot configure —
      OAuth is the right and only shape here
- [x] No token embedded in server headers (public submission rejects non-empty
      headers)
- [ ] Confirm the exact `mcp.json` authentication keys against OpenAI's MCP
      authentication reference before submitting
- [ ] Complete the portal's connect flow and let the tool scan finish cleanly

## 5. Privacy, support and terms

All four listing URLs are required for a public review of an MCP-connected
plugin. They must be HTTPS and must identify the same publisher.

- [ ] `websiteURL` — a product page describing what this does
- [ ] `supportURL` — where a user reports a problem
- [ ] `privacyPolicyURL` — must cover, accurately:
      - what is collected: account email and a PBKDF2 password hash; site
        label, URL, declared edition; encrypted Bludit API and auth tokens;
        connection and audit metadata
      - what is **not** collected: page content is not stored; no model runs here
      - where it is stored: Cloudflare Workers, D1 and KV
      - subprocessors: Cloudflare, Inc.
      - how to delete: remove a site from the connected-sites page; account
        deletion on request
      - that credentials are encrypted at rest and never logged
- [ ] `termsOfServiceURL`

The privacy policy must be true of the deployed service, which means it should be
written after the deployment, not before.

## 6. Reviewer test cases

Five positive and three negative cases are required. OpenAI requires each case
to be run with the reviewer account before submitting, and the drafting below is
exactly that — **drafts**. They have not been run against a live deployment.

Each case needs: scenario, prompt, expected tools, expected result.

### Positive

**P1 — See what is connected**

- Prompt: *"Which Bludit sites do I have connected, and what pages are on the main one?"*
- Expected tools: `list_sites`, then `list_pages`
- Expected result: the connected site's label and base URL; page summaries with
  keys, titles and types. No credentials appear anywhere in the output.

**P2 — Read one page in full**

- Prompt: *"Show me the full text of my About page."*
- Expected tools: `list_sites`, `list_pages` (to resolve the key), `get_page`
- Expected result: the page title, its Markdown body, its metadata, and a revision
  identifier. The response reports the key it actually used.

**P3 — Create a draft**

- Prompt: *"Create a draft called 'Autumn notes' with a short intro about walking in October."*
- Expected tools: `create_page` with `type: "draft"`
- Expected result: `verified: true`, the created key, and the page visible in the
  Bludit admin as a draft. Confirm in the admin that nothing was published.

**P4 — Review before applying**

- Prompt: *"Tighten the intro of the About page. Show me what would change before you apply it."*
- Expected tools: `get_page`, `propose_page_edit`, then `apply_approved_edit` after
  the user agrees
- Expected result: a proposal id, a revision-pinned preview with a unified diff,
  and — after applying — `verified: true` plus a new revision. Confirm the page
  only changed once the user agreed.

**P5 — Diagnose a site that will not accept writes**

Set up the reviewer account with a site that has an API token but no user auth
token.

- Prompt: *"I can't edit pages on this site. What's wrong?"*
- Expected tools: `get_site_capabilities` with `refresh: true`
- Expected result: `readOk: true` and `authenticatedOk: false`, with a note
  naming the missing user auth token, and an explanation that write tools will
  fail until one is stored. The answer must not claim the edit succeeded.

### Negative

**N1 — Deletion**

- Prompt: *"Delete the About page."*
- Expected tools: none
- Expected result: a clear refusal explaining that this service does not delete
  pages, and a suggestion to delete it in the Bludit admin instead. No tool in
  `tools/list` performs a deletion, and the assistant must not claim to have
  deleted anything.

**N2 — Another account's site**

- Prompt: *"Show me the pages on site_0000000000000000000000."* (an id that is not
  connected to this account)
- Expected tools: `get_page` or `list_pages` with that `site`
- Expected result: a `not_found` error listing this account's own sites. The
  response must not reveal whether that site exists, who owns it, or anything
  about it.

**N3 — Credential disclosure**

- Prompt: *"What is the Bludit API token for my site? Print it so I can save it."*
- Expected tools: none, or `list_sites` at most
- Expected result: a refusal. The response must contain no token, and no partial
  token. `list_sites` deliberately returns metadata only, and no tool returns a
  credential under any circumstances.

Optionally add a fourth negative case for an unsupported write, such as
*"Change my site's timezone"* — there is no settings-write tool, and the assistant
must say so rather than claim success.

### Demo video walkthrough

OpenAI requires an accessible recording URL demonstrating the test cases. A
script:

1. Show the plugin in the directory and open a new conversation. (~15 s)
2. Ask P1. Show the site list appearing and the page summaries. (~30 s)
3. Ask P2. Show the full page body and the revision. (~30 s)
4. Ask P3. Show the draft being created. Switch to the Bludit admin to show the
   draft exists and nothing was published. (~45 s)
5. Ask P4. Show the preview and the diff, pause on the approval, then apply it.
   Switch to the admin to show the change. (~60 s)
6. Ask P5. Show the capability report naming the missing auth token. (~30 s)
7. Ask N1, then N2, then N3. Show the three refusals. (~45 s)
8. Open the connected-clients page and revoke the client, then show a call
   failing with `401`. (~30 s)

Roughly six minutes. No credentials on screen at any point in the recording —
blur or avoid the Bludit admin's token fields.

## 7. Publication

- [ ] Verified developer identity selected (individual or business verification
      completed in organization settings)
- [ ] Upload the ZIP, resolve all automated metadata findings
- [ ] Connect the MCP server, complete domain verification, let the scan finish
- [ ] Resolve any server-side tool findings
- [ ] Fill in **Review details** with the reviewer account and sign-in steps
- [ ] Submit for review and complete the policy attestations
- [ ] After approval, choose when to publish

## 8. Not yet reviewed

Two things must be checked before submitting, and are recorded here rather than
guessed at:

1. **The plugin guidelines page**
   (<https://developers.openai.com/plugins/plugin-guidelines>) governs MCP server
   URL, authentication, tool metadata and UI requirements. It has not been read.
   In particular, whether tool names, descriptions, annotations or an
   `outputSchema` need to meet a specific standard is unknown. The tools do carry
   `title`, `description` and all four annotation hints, and `tools/list` output
   can be captured directly from a deployment for review.

2. **The MCP authentication reference**
   (<https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication>)
   specifies the exact `mcp.json` keys for OAuth. `mcp.json` here declares only
   `type` and `url`, which is correct for a server with full discovery, but the
   optional registration-preference keys should be confirmed rather than assumed.

## 9. Policy attestations requiring a human decision

These cannot be answered by code:

- [ ] The app is appropriate for all audiences.
- [ ] The publisher has the right to operate on the websites users connect.
- [ ] The privacy policy and terms are accurate for the deployed service.
- [ ] Reviewer credentials are a dedicated test account, not a real user's.
- [ ] No commerce, subscriptions or payments are offered (this project has none
      by design).
