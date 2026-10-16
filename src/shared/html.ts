/**
 * Minimal HTML helpers for the authorization server's own pages.
 *
 * Every interpolated value goes through `escapeHtml`. Client-supplied strings
 * (client name, redirect URI, scope names) reach these pages, so escaping is
 * not optional here.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Serialize a value for embedding inside a `<script>` block. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface PageOptions {
  title: string;
  body: string;
  /** Extra `<head>` markup. Caller-escaped. */
  head?: string;
  /** Compact layout for consent, which must be readable above the fold. */
  wide?: boolean;
}

const STYLE = `
:root{color-scheme:light dark;--fg:#12161c;--muted:#5b6470;--bg:#f6f7f9;--card:#fff;--line:#e2e5ea;--accent:#2b6cb0;--danger:#b03030}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--muted:#9aa2ad;--bg:#14171c;--card:#1c2026;--line:#2c313a;--accent:#7aa7d9;--danger:#e08b8b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 20px 64px}
main.wide{max-width:880px}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:28px 0 10px}
p{margin:8px 0}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}
label{display:block;font-weight:600;margin:12px 0 4px}
input,select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:9px 16px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;overflow-wrap:anywhere}
.token{display:block;padding:10px;border:1px dashed var(--line);border-radius:7px;background:var(--bg);font-family:ui-monospace,monospace;overflow-wrap:anywhere}
.error{color:var(--danger);font-weight:600}
.notice{border-left:3px solid var(--accent);padding-left:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
ul{margin:8px 0;padding-left:20px}
.scopes li{font-family:ui-monospace,monospace}
`;

export function renderPage(options: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(options.title)} — Bludit Wizard</title>
<style>${STYLE}</style>
${options.head ?? ''}
</head><body><main${options.wide ? ' class="wide"' : ''}>${options.body}</main></body></html>`;
}

export function htmlResponse(html: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      ...Object.fromEntries(new Headers(headers))
    }
  });
}
