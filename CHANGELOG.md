# Changelog

All notable changes to Bludit Wizard MCP are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-23

First stable release. Local-first MCP server for Bludit CMS, distributed as a
GitHub release asset. Not published to the npm registry.

### Added

- Nineteen MCP tools over stdio: site discovery (`list_sites`, `select_site`,
  `get_site_capabilities`), website information (`get_website_settings`), page
  retrieval (`list_pages`, `get_page`, `get_drafts`, `get_scheduled_pages`),
  taxonomy (`list_categories`, `list_tags`), deterministic content intelligence
  (`search_pages`, `get_content_summary`, `get_related_pages`), and controlled
  modification (`create_page`, `edit_page`, `propose_page_edit`,
  `preview_page_changes`, `apply_approved_edit`, `verify_page_update`).
- Revision-pinned proposal workflow: propose, preview, apply, verify, with replay
  refusal and stale-revision refusal.
- SSRF policy, bounded responses, request timeouts and structured error codes.
- Local stdio edition with one site from environment variables or a JSON config
  file, read-only mode when no user auth token is supplied, and audit lines on
  stderr.
- Portable core shared with the preserved Cloudflare Workers transport.
- Packaging: `bin` entry, compiled `dist/`, prepack build, Node.js `>=20`.

### Changed

- Licensed under GPL-3.0-only; the upstream `bludit/bludit-mcp` MIT notice is
  retained in `NOTICE`.
- Version raised to 1.0.0 for the first stable release.
- README rewritten for installation, OpenCode integration, security, limitations
  and testing.

### Fixed

- A `2xx` upstream response with a non-JSON body (for example an HTML maintenance
  page) was treated as `{}` and reported as an empty but successful result. It now
  raises a retryable `upstream_error`. Empty bodies remain accepted. Covered by two
  regression tests.

### Security

- No credential is printed, logged, or returned in a response or error.
- Deletion and unattended publication tools are deliberately absent.

### Verified

- 438 hermetic tests, 9 browser tests and 18 Docker-backed live tests against
  Bludit Community 3.22.0, all passing.
- OpenCode 2.0.21 driven end to end against a real Bludit site.

### Known limitations

- Revision pinning does not serialise two independent writers racing on the same
  revision; Bludit provides no conditional write.
- Proposals are process-local, expire, and do not survive a restart.
- Only OpenCode has been verified as an MCP client.
- Bludit slug derivation keeps punctuation and Unicode in page keys.

[1.0.0]: https://github.com/gitdamnit/bludit-wizard-mcp/releases/tag/v1.0.0
