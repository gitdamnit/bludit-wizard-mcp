# Bludit Wizard MCP v1.0.0

Initial stable release of Bludit Wizard MCP, a local-first Model Context Protocol
server bringing nineteen Bludit content-management tools to compatible AI clients.

Bludit Wizard MCP runs on your own computer and talks to one Bludit site through
the official API plugin. There is no hosted service, no account, no OAuth server
and no database. It performs no inference and stores no page content.

## Highlights

- **Nineteen tools** for site discovery, reading, taxonomy, deterministic search
  and summaries, and controlled content modification.
- **Human-controlled editing**: propose → preview → approve → apply → verify.
  Proposals are immutable, revision-pinned, expire after 15 minutes, and cannot be
  applied twice.
- **Read access with the API token alone**; writes and site settings require the
  user auth token. Without it the server runs read-only and says so.
- **Security boundaries**: HTTPS-only site URLs, SSRF rejection for loopback,
  private, link-local and metadata addresses, redirect re-validation, request
  timeouts, response-size limits, and stable structured error codes with no
  credential leakage.
- **No deletion tool and no unattended publication.**
- **Verified with OpenCode 2.0.21** end to end against a real Bludit site.

## Tools

Site management: `list_sites`, `select_site`, `get_site_capabilities`.

Website information: `get_website_settings`.

Page retrieval: `list_pages`, `get_page`, `get_drafts`, `get_scheduled_pages`.

Taxonomy: `list_categories`, `list_tags`.

Content intelligence: `search_pages`, `get_content_summary`, `get_related_pages`.

Controlled modification: `create_page`, `edit_page`, `propose_page_edit`,
`preview_page_changes`, `apply_approved_edit`, `verify_page_update`.

## Installation

This release is distributed as the attached package tarball; it is **not**
published to the npm registry.

```bash
curl -LO https://github.com/gitdamnit/bludit-wizard-mcp/releases/download/v1.0.0/bludit-wizard-mcp-1.0.0.tgz
npm install -g ./bludit-wizard-mcp-1.0.0.tgz
bludit-wizard-mcp --version
```

Verify the download first:

```bash
sha256sum bludit-wizard-mcp-1.0.0.tgz
# SHA-256: 4b0d1979f2be98f6937a3b68af19f9b18537ee26680ae048d643bc8b0dcf87e5
```

Requirements: Node.js 20 or newer; Bludit 3.22.x with the API plugin enabled; an
API token; optionally the admin user auth token for writes and settings.

The complete corresponding source for this release is available at
<https://github.com/gitdamnit/bludit-wizard-mcp/tree/v1.0.0>.

## OpenCode configuration

```jsonc
{
  "mcp": {
    "servers": {
      "bludit": {
        "type": "local",
        "command": ["bludit-wizard-mcp"],
        "environment": {
          "BLUDIT_URL": "https://www.example.com",
          "BLUDIT_API_TOKEN": "{env:BLUDIT_API_TOKEN}",
          "BLUDIT_AUTH_TOKEN": "{env:BLUDIT_AUTH_TOKEN}"
        }
      }
    }
  }
}
```

## Fixed in this release

- A `2xx` upstream response with a non-JSON body (for example an HTML maintenance
  page) was treated as an empty successful result. It now raises a retryable
  `upstream_error`; an empty body remains accepted. Two regression tests cover it.

## Testing

- 438 hermetic tests across 27 files, 0 failed.
- 9 Playwright browser tests, 0 failed.
- 18 Docker-backed live tests against Bludit Community 3.22.0 (12 hosted-transport
  compatibility tests and 6 local stdio tests), 0 failed.
- Live acceptance through OpenCode: all 19 tools exercised, plus approximately 90
  isolated positive and negative probes. Report:
  `docs/LIVE_ACCEPTANCE_REPORT.md`.

## Security

- Missing API token prevents startup; invalid tokens produce structured
  authentication failures.
- Reads and writes respect separate credentials; settings require the auth token.
- SSRF protections cover loopback, localhost, private and link-local ranges, cloud
  metadata endpoints, restricted schemes, embedded credentials, invalid ports and
  redirects to restricted destinations.
- Request timeouts, response-size caps, malformed-JSON rejection and stable error
  codes are covered by tests.

## Known limitations

- No delete tool and no unattended publication.
- Proposals are process-local, expire, and do not survive a restart.
- Revision pinning does not serialise two independent writers racing on the same
  revision; Bludit has no conditional write, so the last write wins in that case.
  Applying the same proposal twice is refused.
- Bludit slug derivation keeps punctuation and Unicode in page keys.
- `search_pages` with `include_content` requires `scan_limit <= 40`.
- Site settings require the user auth token.
- Only OpenCode has been verified as an MCP client; other stdio clients are
  expected to work but have not been tested.

## Licence

GPL-3.0-only. The upstream `bludit/bludit-mcp` MIT notice and copyright are retained
in `NOTICE`; the repository keeps upstream's full Git history.
