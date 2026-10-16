---
name: get-started
description: Connect your first Bludit website to Bludit Wizard so you can read and update its pages.
---

# Connect a Bludit website

Bludit Wizard only works on websites you have connected to your own account.

## Before you start

You need two values from the Bludit admin area:

1. **API token** — Admin → Plugins → API → Settings → API token. This is the
   read-only token. Enable the API plugin first if it is not already enabled.
2. **User auth token** — Admin → Users → your user → Security tab → Token. This
   is what allows writing, and what allows reading the site's settings.

The auth token is optional: without it you can still read pages, you just cannot
create or edit them.

## Steps

1. Open the Bludit Wizard site and sign in, or create an account.
2. Choose **Connect a Bludit site** and select **Generate pairing challenge**.
3. The page shows a one-time challenge. The site must prove it received it, in
   one of two ways:
   - **With the Bludit Wizard plugin**, the plugin answers for you. Enter its
     *GPT Action API key* in the connection form.
   - **Without any plugin**, publish the challenge, on its own, at
     `https://your-site/.well-known/bludit-wizard-challenge.txt`.
4. Enter the site URL, the API token, and the auth token, then choose
   **Connect site**.
5. Return to the client you were using and re-authorize if you were asked to.

## Then

- Start with `list_sites` to see what is connected.
- `list_pages` gives you summaries; `get_page` gives you one page in full.
- To change a page safely, use `propose_page_edit` and then
  `apply_approved_edit`. Applying is refused if someone else edited the page in
  the meantime, so you will never silently overwrite newer work.

## If something does not work

Ask for `get_site_capabilities`. It reports whether the site's API plugin is
reachable, whether write access works, and whether the Bludit Wizard plugin was
detected — which is usually enough to tell you what is missing.
