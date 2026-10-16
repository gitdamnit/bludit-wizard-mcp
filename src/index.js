#!/usr/bin/env node
/**
 * Legacy single-site stdio MCP server.
 *
 * PROVENANCE
 *   This file is the upstream `bludit/bludit-mcp` server, retained so existing
 *   stdio users (Claude Desktop, Gemini CLI, and similar) keep working. It is
 *   Copyright (c) 2026 Diego Najar and used under the MIT License; see LICENSE
 *   and NOTICE. Only this header was added.
 *
 *   It is superseded by the hosted server in `src/mcp/` and `src/auth/`, which
 *   adds OAuth 2.1, multiple sites per account, the proposal/approval workflow,
 *   capability detection and the SSRF policy. See docs/UPSTREAM_COMPARISON.md.
 *
 *   Kept deliberately unchanged: this server reads one site from environment
 *   variables and serves one user. Do not add hosted-service concerns here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.BLUDIT_URL ?? "").replace(/\/+$/, "");
const API_TOKEN = process.env.BLUDIT_API_TOKEN ?? "";
const AUTH_TOKEN = process.env.BLUDIT_AUTH_TOKEN ?? "";

if (!BASE) {
  console.error("[bludit-mcp] BLUDIT_URL is required (e.g. https://www.example.com)");
  process.exit(1);
}
if (!API_TOKEN) {
  console.error("[bludit-mcp] BLUDIT_API_TOKEN is required");
  process.exit(1);
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function callApi({ method, path, query = {}, body, requireAuth = false }) {
  if (requireAuth && !AUTH_TOKEN) {
    throw new Error("BLUDIT_AUTH_TOKEN is required for write operations");
  }

  // The Bludit API plugin reads inputs from $_GET for GET/DELETE and from
  // the request body for POST/PUT. It does not merge the two. Place the
  // token (and authentication) where the plugin will actually look.
  const useQuery = method === "GET" || method === "DELETE";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }

  const opts = { method, headers: {} };
  if (useQuery) {
    params.set("token", API_TOKEN);
    if (requireAuth) params.set("authentication", AUTH_TOKEN);
  } else {
    const payload = {
      token: API_TOKEN,
      ...(requireAuth ? { authentication: AUTH_TOKEN } : {}),
      ...(body ?? {})
    };
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(payload);
  }

  const qs = params.toString();
  const url = `${BASE}/api${path}${qs ? "?" + qs : ""}`;

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    throw new Error(`Bludit API ${res.status}: ${data.message ?? "Unknown error"}`);
  }
  return data;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// Fetch website settings at startup to build automatic context for Claude.
// Requires AUTH_TOKEN; silently skips if it is absent or the call fails.
async function fetchWebsiteSettings() {
  if (!AUTH_TOKEN) return null;
  try {
    return await callApi({ method: "GET", path: "/settings", requireAuth: true });
  } catch {
    return null;
  }
}

const websiteSettings = await fetchWebsiteSettings();

function buildInstructions(settings) {
  const parts = ["You are managing a Bludit CMS website via its REST API."];
  if (!settings) return parts.join("\n");

  // The API wraps the site fields under a 'data' key: { status, message, data: { ... } }
  const site = settings.data ?? settings;
  const name = site.title ?? site.name ?? "";
  const description = site.description ?? "";
  const language = site.language ?? site.locale ?? "";

  if (name) parts.push(`Website name: ${name}`);
  if (description) parts.push(`Description: ${description}`);
  if (language) {
    parts.push(`Language: ${language}. Write all content and replies in this language unless the user explicitly asks otherwise.`);
  }
  return parts.join("\n");
}

const server = new McpServer({
  name: "bludit-mcp",
  version: "0.1.0",
  instructions: buildInstructions(websiteSettings)
});

server.tool(
  "get_website_settings",
  "Get the Bludit website settings including name, description, language, and other site configuration. Requires write authentication.",
  {},
  async () => ok(await callApi({ method: "GET", path: "/settings", requireAuth: true }))
);

server.tool(
  "list_pages",
  "List Bludit pages with optional type filters and pagination. Returns the paged data slice plus meta { total, pageNumber, pageSize, hasMore }.",
  {
    published: z.boolean().optional().describe("Include published pages (default true)"),
    static: z.boolean().optional().describe("Include static pages (default false)"),
    sticky: z.boolean().optional().describe("Include sticky pages (default false)"),
    draft: z.boolean().optional().describe("Include draft pages (default false)"),
    scheduled: z.boolean().optional().describe("Include scheduled pages (default false)"),
    untagged: z.boolean().optional().describe("Filter to pages without tags. Applied client-side after pagination, so meta.total still reflects the unfiltered count and a paged slice may contain fewer items than pageSize. When using untagged, prefer numberOfItems: -1 to get all matches in one response."),
    pageNumber: z.number().int().min(1).optional().describe("Page number, 1-indexed"),
    numberOfItems: z.number().int().optional().describe("Page size. -1 returns all matching pages. Recommended when untagged is true.")
  },
  async (args) => ok(await callApi({ method: "GET", path: "/pages", query: args }))
);

server.tool(
  "get_page",
  "Get a single Bludit page by its key. The key is the slug, possibly hierarchical like 'parent/child'.",
  {
    key: z.string().describe("Page key, e.g. 'about' or 'parent/child'")
  },
  async ({ key }) => ok(await callApi({ method: "GET", path: `/pages/${encodeKey(key)}` }))
);

const pageWritableFields = {
  title: z.string().describe("Page title"),
  content: z.string().optional().describe("Markdown content"),
  description: z.string().optional().describe("Short description"),
  type: z.enum(["published", "draft", "static", "sticky", "scheduled"]).optional()
    .describe("Page type. Defaults to 'published' on create."),
  slug: z.string().optional().describe("Custom URL slug. Defaults to a slugified title."),
  parent: z.string().optional().describe("Parent page key for hierarchical pages"),
  category: z.string().optional().describe("Category key"),
  tags: z.string().optional().describe("Comma-separated tag list"),
  date: z.string().optional().describe("Publish date 'YYYY-MM-DD HH:MM:SS'"),
  coverImage: z.string().optional().describe("Cover image filename (already uploaded)"),
  template: z.string().optional().describe("Theme template name"),
  position: z.number().int().optional().describe("Sort position")
};

server.tool(
  "create_page",
  "Create a new Bludit page. Returns the full created page object. Requires write authentication.",
  pageWritableFields,
  async (args) => ok(await callApi({ method: "POST", path: "/pages", body: args, requireAuth: true }))
);

server.tool(
  "edit_page",
  "Edit an existing Bludit page. Pass only the fields you want to change. Returns the full updated page object. Requires write authentication.",
  {
    key: z.string().describe("Existing page key"),
    title: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    type: z.enum(["published", "draft", "static", "sticky", "scheduled"]).optional(),
    slug: z.string().optional(),
    parent: z.string().optional(),
    category: z.string().optional(),
    tags: z.string().optional(),
    date: z.string().optional(),
    coverImage: z.string().optional(),
    template: z.string().optional(),
    position: z.number().int().optional()
  },
  async ({ key, ...body }) => ok(await callApi({
    method: "PUT",
    path: `/pages/${encodeKey(key)}`,
    body,
    requireAuth: true
  }))
);

server.tool(
  "delete_page",
  "Delete a Bludit page by key. Requires write authentication.",
  {
    key: z.string().describe("Page key to delete")
  },
  async ({ key }) => ok(await callApi({
    method: "DELETE",
    path: `/pages/${encodeKey(key)}`,
    requireAuth: true
  }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
