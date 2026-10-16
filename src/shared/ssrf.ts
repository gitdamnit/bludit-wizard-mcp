/**
 * SSRF defences for every outbound request to a user-supplied Bludit site.
 *
 * Three independent layers, in order of strength:
 *
 *  1. **Runtime.** Both Workers set the `global_fetch_strictly_public`
 *     compatibility flag, so workerd itself refuses to connect to private or
 *     otherwise non-public addresses. This is the backstop that survives a bug
 *     here.
 *  2. **Static URL policy** (this module). Rejects non-HTTPS schemes, embedded
 *     credentials, IP literals in reserved ranges (including IPv4-mapped,
 *     NAT64, 6to4 and IPv4-compatible IPv6 forms), and internal-only hostnames.
 *     The WHATWG URL parser normalizes obfuscated IPv4 literals such as
 *     `2130706433`, `0x7f000001` and `0177.0.0.1` into dotted-quad, so those
 *     are caught by the range checks below.
 *  3. **Redirect policy.** `redirect: 'manual'` plus revalidation of every
 *     `Location` hop, so a public host cannot bounce us inward.
 *
 * A hostname is not resolved here — workerd does not expose DNS. The runtime
 * flag in layer 1 is what covers DNS rebinding.
 */

export interface UrlPolicy {
  /** Permit `http://` for loopback hosts only. Development/test use. */
  allowInsecure: boolean;
}

export interface UrlCheck {
  ok: boolean;
  /** Populated only when `ok` is true. */
  url?: URL;
  /** Stable, non-secret reason suitable for returning to a caller. */
  reason?: string;
}

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const INTERNAL_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.home.arpa',
  '.in-addr.arpa',
  '.ip6.arpa',
  '.localdomain'
];

const INTERNAL_HOST_EXACT = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default'
]);

/** IPv4 CIDR blocks that must never be reachable. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // "this network"
  [0x0a000000, 8], // private
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, incl. 169.254.169.254
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // TEST-NET-1
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4] // reserved + broadcast
];

function ipv4ToInt(octets: number[]): number {
  return (((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number)) >>> 0;
}

function inCidr(address: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function isBlockedV4(address: number): boolean {
  return BLOCKED_V4.some(([base, prefix]) => inCidr(address, base, prefix));
}

function parseIpv4(host: string): number | null {
  const match = IPV4_LITERAL.exec(host);
  if (!match) return null;
  const octets = match.slice(1, 5).map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => value > 255)) return null;
  return ipv4ToInt(octets);
}

/** Expand an IPv6 literal into 8 hextets. Returns null when unparseable. */
function parseIpv6(input: string): number[] | null {
  let host = input;
  // Strip a zone identifier such as `fe80::1%eth0`.
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  if (!host.includes(':')) return null;

  // A trailing dotted-quad is legal for IPv4-mapped, IPv4-compatible and NAT64
  // addresses. Pull it out so group counting stays correct: `::ffff:127.0.0.1`
  // is one explicit group (`ffff`) plus the two groups the IPv4 address encodes,
  // not `::ffff:0:0`.
  let v4Tail: number[] = [];
  const lastColon = host.lastIndexOf(':');
  const maybeV4 = host.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) return null;
    v4Tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    host = host.slice(0, lastColon);
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;

  const toHextets = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = toHextets(halves[0] ?? '');
  const rear = halves.length === 2 ? toHextets(halves[1] ?? '') : [];
  if (head === null || rear === null) return null;

  const explicit = head.length + rear.length;

  if (halves.length === 1) {
    // No `::`, so every group must be explicit.
    if (explicit !== 8 - v4Tail.length) return null;
    return [...head, ...v4Tail];
  }

  const missing = 8 - explicit - v4Tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rear, ...v4Tail];
}

function hextetsToBigInt(parts: number[]): bigint {
  let value = 0n;
  for (const part of parts) value = (value << 16n) | BigInt(part);
  return value;
}

/** Mask with the top `bits` bits set, for a 128-bit address. */
function prefixMask(bits: number): bigint {
  return ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
}

function matchesPrefix(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = prefixMask(bits);
  return (value & mask) === (prefix & mask);
}

/**
 * IPv6 blocks that must never be reachable. Prefixes are written as 128-bit
 * values: the prefix's own bits, aligned to the top of the address.
 */
const BLOCKED_V6: ReadonlyArray<{ prefix: bigint; bits: number; label: string }> = [
  { prefix: 0n, bits: 128, label: 'unspecified' },
  { prefix: 1n, bits: 128, label: 'loopback' },
  { prefix: 0x0100n << 112n, bits: 64, label: 'discard-only' },
  { prefix: 0x20010db8n << 96n, bits: 32, label: 'documentation' },
  { prefix: 0xfc00n << 112n, bits: 7, label: 'unique local' },
  { prefix: 0xfe80n << 112n, bits: 10, label: 'link local' },
  { prefix: 0xff00n << 112n, bits: 8, label: 'multicast' },
  // `::ffff:0:0/96` and `64:ff9b::/96` carry an embedded IPv4 address in the
  // last 32 bits; their own prefix bits sit at 80..95, not at the very top.
  { prefix: 0xffffn << 32n, bits: 96, label: 'ipv4-mapped' },
  { prefix: 0x0064ff9bn << 96n, bits: 96, label: 'nat64' }
];

function isBlockedV6(parts: number[]): boolean {
  const value = hextetsToBigInt(parts);

  for (const block of BLOCKED_V6) {
    if (matchesPrefix(value, block.prefix, block.bits)) return true;
  }

  const embeddedV4 = (index: number): number =>
    ((((parts[index] as number) << 16) | (parts[index + 1] as number)) >>> 0);

  const isV4Mapped = matchesPrefix(value, 0xffffn << 32n, 96);
  const isNat64 = matchesPrefix(value, 0x0064ff9bn << 96n, 96);
  const is6to4 = parts[0] === 0x2002;

  if (isV4Mapped) return isBlockedV4(embeddedV4(6));
  if (isNat64) return isBlockedV4(embeddedV4(6));
  if (is6to4) return isBlockedV4(embeddedV4(1));

  // `::/96` IPv4-compatible addresses are not routable in practice.
  if (value >> 32n === 0n) return true;

  return false;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = parseIpv4(host);
  if (v4 !== null) return inCidr(v4, 0x7f000000, 8);
  const v6 = parseIpv6(host);
  if (v6 !== null) return hextetsToBigInt(v6) === 1n;
  return false;
}

/** Validate a single URL against the static policy. No network access. */
export function checkSiteUrl(raw: string, policy: UrlPolicy): UrlCheck {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'Site URL is empty.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Site URL is not a valid absolute URL.' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'Site URL must not embed credentials.' };
  }
  if (url.hash !== '') {
    return { ok: false, reason: 'Site URL must not contain a fragment.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Site URL must use https.' };
  }

  const host = url.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'Site URL has no host.' };

  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // Loopback is treated separately: it is never acceptable for a hosted
  // deployment, but a local Bludit instance on `http://127.0.0.1:8080` is the
  // normal way to develop against this server. Only the explicit development
  // flag opens it, and only for loopback — never for a LAN address.
  if (isLoopbackHost(bare)) {
    if (!policy.allowInsecure) {
      return {
        ok: false,
        reason:
          'Loopback site URLs are only permitted in development mode (ALLOW_INSECURE_SITE_URLS=true).'
      };
    }
    return { ok: true, url };
  }

  if (INTERNAL_HOST_EXACT.has(bare)) {
    return { ok: false, reason: 'Site URL resolves to an internal hostname.' };
  }
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) {
    return { ok: false, reason: 'Site URL resolves to an internal hostname.' };
  }

  const v4 = parseIpv4(bare);
  if (v4 !== null && isBlockedV4(v4)) {
    return { ok: false, reason: 'Site URL resolves to a private or reserved address.' };
  }
  const v6 = parseIpv6(bare);
  if (v6 !== null && isBlockedV6(v6)) {
    return { ok: false, reason: 'Site URL resolves to a private or reserved address.' };
  }

  if (url.protocol === 'http:') {
    return { ok: false, reason: 'Site URL must use https. Plain http is permitted only for loopback in development.' };
  }

  return { ok: true, url };
}

/**
 * Normalize a site base URL: drop the trailing slash, query and fragment, and
 * lowercase the scheme and host. A CMS installed in a subdirectory keeps its
 * path, because Bludit is frequently deployed that way.
 */
export function normalizeBaseUrl(input: URL): string {
  const path = input.pathname.replace(/\/+$/, '');
  return `${input.protocol}//${input.host.toLowerCase()}${path}`;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Hard cap on redirect hops. */
  maxRedirects?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the number of bytes read from the response body. */
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  /** Parsed JSON when the body is JSON, otherwise null. */
  json: unknown;
  /** Raw text, truncated to `maxBytes`. */
  text: string;
  /** Final URL after redirects. */
  finalUrl: string;
}

/**
 * Bounded, redirect-revalidating fetch for user-supplied hosts.
 *
 * Returns a result object for every HTTP outcome, including non-2xx, so callers
 * decide the error policy. Throws only for policy violations and transport
 * failures, never echoing a URL that might carry a token.
 */
export async function safeFetch(
  target: URL,
  policy: UrlPolicy,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 512 * 1024;

  let current = target;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = checkSiteUrl(current.toString(), policy);
    if (!check.ok) throw new SsrfBlockedError(check.reason ?? 'Blocked by SSRF policy');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(check.url as URL, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      throw new UpstreamTransportError(error instanceof Error ? error.message : 'network failure');
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new UpstreamTransportError('redirect without a Location header');
      try {
        current = new URL(location, check.url);
      } catch {
        throw new UpstreamTransportError('redirect to an unparseable URL');
      }
      continue;
    }

    const { text, truncated } = await readBounded(response, maxBytes);
    if (truncated) throw new UpstreamTransportError('response exceeded the maximum accepted size');

    let json: unknown = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    return { status: response.status, headers: response.headers, json, text, finalUrl: current.toString() };
  }

  throw new UpstreamTransportError('too many redirects');
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { text: '', truncated: true };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated: false };
}

export class SsrfBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
  }
}

export class UpstreamTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTransportError';
  }
}
