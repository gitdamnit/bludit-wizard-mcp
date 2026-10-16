/**
 * Cookie helpers for the authorization server's own browser session.
 *
 * The remembered-consent cookie is owned by the OAuth library; this module only
 * handles the account session and CSRF cookie.
 */

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name === '') continue;
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  expires?: Date;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function clearCookie(name: string, secure = true): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure });
}

/**
 * `__Host-` is the strictest cookie prefix: Secure, Path=/, no Domain. Browsers
 * refuse it over plain http, so local development (issuer on http://localhost)
 * falls back to an unprefixed name. Production always uses the prefix.
 */
export function sessionCookieName(issuer: string): string {
  return new URL(issuer).protocol === 'https:' ? '__Host-bw_session' : 'bw_session';
}

export function csrfCookieName(issuer: string): string {
  return new URL(issuer).protocol === 'https:' ? '__Host-bw_csrf' : 'bw_csrf';
}
