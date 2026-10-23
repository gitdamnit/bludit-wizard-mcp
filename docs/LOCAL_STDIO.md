# Local stdio edition

Run Bludit Wizard MCP on your own computer, connected to your own Bludit site.
No account, no hosted service, no OAuth server, no database, and nothing for
anyone else to operate or pay for.

This is the primary distribution. The Cloudflare Workers transport still exists
and is still supported — see [ARCHITECTURE.md](./ARCHITECTURE.md) — but it is
optional and no longer the default.

---

## 1. What you need

| | |
|---|---|
| **Node.js** | 20 or newer (`node --version`) |
| **Bludit** | 3.22.x, Community or Pro, reachable over HTTPS |
| **An MCP client** | OpenCode, Claude Desktop, or any client that supports stdio servers |

Nothing else. No Docker, no Cloudflare account, no database.

---

## 2. Create the Bludit credentials

Two of the three values come from your Bludit admin panel.

**API token** — *required*. Reads and writes both use it.

1. Sign in to Bludit as an administrator.
2. **Admin → Plugins → API → Settings**.
3. Make sure the API plugin is **enabled**.
4. Copy the **API token**.

**User auth token** — *optional, but needed to write*. Without it the server is
read-only, and it says so on startup.

1. **Admin → Users → (your user) → Security**.
2. Copy the **Token**.

**Wizard extension key** — *optional*. Only if you also run the Bludit Wizard
plugin and want its extended endpoints.

---

## 3. Run it

Install the release tarball from the GitHub release (this release is not
published to the npm registry):

```bash
curl -LO https://github.com/gitdamnit/bludit-wizard-mcp/releases/download/v1.0.0/bludit-wizard-mcp-1.0.0.tgz
npm install -g ./bludit-wizard-mcp-1.0.0.tgz
```

Or, straight from a checkout, build it and run the compiled entry point:

```bash
npm ci && npm run build:local
```

Then start the server with the three values:

```bash
BLUDIT_URL=https://www.example.com \
BLUDIT_API_TOKEN='your-api-token' \
BLUDIT_AUTH_TOKEN='your-auth-token' \
bludit-wizard-mcp
```

It prints one line to stderr and then waits on stdin:

```
[bludit-wizard] 1.0.0 serving www.example.com (https://www.example.com)
```

That is the server running correctly. It is speaking MCP over stdin/stdout; it is
not meant to be used from a shell.

### Configuration reference

Environment variables, or a JSON file, or both. **Environment variables win**, so
you can keep the URL and label in a file and the secrets in the environment.

| Variable | Required | Meaning |
|---|---|---|
| `BLUDIT_URL` | yes | Site root, e.g. `https://www.example.com`. HTTPS, or loopback http with the flag below. |
| `BLUDIT_API_TOKEN` | yes | The API token from step 2. |
| `BLUDIT_AUTH_TOKEN` | no | The user auth token. Without it the server is read-only. |
| `BLUDIT_WIZARD_API_KEY` | no | Wizard extension key. |
| `BLUDIT_WIZARD_API_BASE` | no | Defaults to `<site>/api/wizard`. |
| `BLUDIT_SITE_LABEL` | no | Display name in tool output. Defaults to the hostname. |
| `BLUDIT_ALLOW_INSECURE_URLS` | no | `true` permits plain http **on loopback only**, for local development. |
| `BLUDIT_CONFIG_FILE` | no | Path to a JSON config file. |

A config file is just a JSON object of those names:

```json
{
  "BLUDIT_URL": "https://www.example.com",
  "BLUDIT_API_TOKEN": "…",
  "BLUDIT_AUTH_TOKEN": "…",
  "BLUDIT_SITE_LABEL": "My blog"
}
```

```bash
chmod 600 bludit.json          # the server warns if others can read it
bludit-wizard-mcp --config ./bludit.json
```

The file is read once, at startup. It is never written to.

---

## 4. Add it to your MCP client

The server is a normal stdio MCP server, so any client that supports one will
work. Configuration is per client, and these are the shapes that matter.

### OpenCode

`opencode.json` in your project, or the global config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "bludit": {
      "type": "local",
      "command": ["bludit-wizard-mcp"],
      "environment": {
        "BLUDIT_URL": "https://www.example.com",
        "BLUDIT_API_TOKEN": "{env:BLUDIT_API_TOKEN}",
        "BLUDIT_AUTH_TOKEN": "{env:BLUDIT_AUTH_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

Keeping the tokens in the surrounding environment rather than in the config file
is the better default: the config often ends up in version control, the
environment usually does not.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bludit": {
      "command": "bludit-wizard-mcp",
      "env": {
        "BLUDIT_URL": "https://www.example.com",
        "BLUDIT_API_TOKEN": "…",
        "BLUDIT_AUTH_TOKEN": "…"
      }
    }
  }
}
```

### Anything else

Run `bludit-wizard-mcp` as the command (or `node dist/local/index.js` from a
checkout). It takes no required arguments and communicates only over stdio. `--config <file>` is the only option you are likely
to want.

---

## 5. The nineteen tools

Identical to the hosted transport — same names, same schemas, same behaviour, from
the same source file. `tools/list` returns exactly this set.

**Reading** — `list_sites`, `get_site_capabilities`, `select_site`,
`get_website_settings`, `list_pages`, `get_page`, `search_pages`,
`list_categories`, `list_tags`, `get_drafts`, `get_scheduled_pages`,
`get_content_summary`, `get_related_pages`, `preview_page_changes`,
`verify_page_update`.

**Writing** — `create_page`, `edit_page`, `propose_page_edit`,
`apply_approved_edit`.

**Deleting** — nothing. There is no delete tool in this server, and its absence is
a policy decision, not an omission.

`site` is an optional argument on every tool and you can always omit it: there is
exactly one site, the one you configured.

---

## 6. How writing works, and why

Two paths, and the difference matters:

- **`create_page` and `edit_page` write immediately.** They then read the page back
  and report `verified: true` only if the change is actually there. They are
  annotated as writes, so a client can tell them apart from reads.
- **`propose_page_edit` → `apply_approved_edit` is the review path.**
  `propose_page_edit` records the change, touches nothing, and returns a preview and
  a proposal id pinned to the page's current revision. `apply_approved_edit`
  requires `confirm: true`, re-reads the page, and refuses if the revision moved.
  The pin is what stops a reviewed change from clobbering a newer edit.

Use the proposal path whenever a human should look before it lands. Every write is
verified by reading it back, and no tool ever reports success it has not confirmed.

**Proposals are held in memory.** They have the same lifetime (15 minutes by
default) and the same revision pin as the hosted version, but they do not survive a
restart of the server. Restarting means proposing again. That is [decision
D-0004](../DECISION_LOG.md) — the alternative was writing page content and revision
data to a second file on disk for no real gain.

---

## 7. Security, honestly

Most of this is inherited from the shared security work and is described in full in
[SECURITY.md](./SECURITY.md). What is specific to running locally:

**A local MCP process is not a sandbox.** It runs with your privileges and can do
anything you can do. It is not a security boundary, and nothing here changes that.

**Credentials live on your disk.** In an environment variable, or a config file you
should `chmod 600`. They are read at startup, held in memory, sent only to the site
you configured, and never printed — no log line, no error message and no tool
response contains them, and the test suite asserts that. But they are on your disk,
and how safe that is depends on your machine.

**No OAuth, deliberately.** The hosted service needs an authorization server
because it acts for many users over a network. A local process acting for you, on
your own machine, has nobody to authenticate against except itself. Adding an
identity layer here would be ceremony, not security. What *is* kept is everything
that protects your site: no deletion, review-before-write, credential redaction,
URL validation and request limits.

**SSRF protection is weaker here than on Cloudflare, and you should know it.** The
hosted version has a platform layer: Cloudflare's `global_fetch_strictly_public`
makes the runtime itself refuse private addresses, and it is the only layer that
covers DNS rebinding. **That layer does not exist in Node.** What you do get:

| Layer | Local |
|---|---|
| URL policy: scheme, reserved ranges, credentials-in-URL | yes |
| Redirect revalidation on every hop | yes |
| Bounded response size and request timeouts | yes |
| Platform-level private-address refusal | **no** |
| DNS-rebinding coverage | **no** |

In practice the exposure is small: you configured the one URL, and a URL you
control is not a URL an attacker supplied. Do not point this at a hostname you do
not control, and do not put it on a machine reachable by people you do not trust.
If you want a network-exposed deployment, that is the self-hosted HTTP transport,
which is designed (see [SELF_HOSTED_HTTP.md](./SELF_HOSTED_HTTP.md)) but not
implemented.

**Tool authorization is vacuous here.** The hosted server checks OAuth scopes on
every tool. Locally the running client holds every scope, because there is no
second principal to distinguish it from. The check still *runs* — the same code
path — it just cannot fail. If a client can talk to this process, it can use every
tool, and that is the intended trust model.

---

## 8. Troubleshooting

**`BLUDIT_URL is required` and the process exits 1.** Configuration is missing.
The message lists every problem at once; fix them together.

**`BLUDIT_URL was rejected: Loopback site URLs are only permitted…`** You used
plain http, or a private address. Use HTTPS. For a local test Bludit, set
`BLUDIT_ALLOW_INSECURE_URLS=true` (loopback only).

**`[read-only: no BLUDIT_AUTH_TOKEN]` in the startup line.** Reads work; writes
will be refused by Bludit. Add the user auth token.

**Writes fail with a permission error from the site.** The Bludit user whose token
you copied is probably not an administrator. Only admin tokens may write.

**The client reports a protocol error or hangs on startup.** Something wrote to
stdout that was not MCP. Node warnings (`ExperimentalWarning`, deprecation notices)
printed by the runtime itself are the usual cause. Send the stderr output — the
server's own diagnostics are all there, and none of them are on stdout.

**A proposal id stopped working.** Proposals expire after 15 minutes, and they do
not survive a restart. Propose the change again.

---

## 9. Uninstalling

If you installed the tarball globally, remove it with
`npm uninstall -g bludit-wizard-mcp`. Remove the entry from your MCP client's
config; optionally delete the config file with your credentials in it.
