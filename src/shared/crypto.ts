/**
 * Cryptographic primitives, implemented against WebCrypto only.
 *
 * No third-party crypto dependency, no Node built-ins: everything here runs
 * unchanged in workerd and in Node >= 20 (used by the unit tests).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return decoder.decode(view);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Cryptographically random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/** Opaque, sortable-ish identifier. Not a secret; never used for authorization alone. */
export function newId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? utf8(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a JSON-serializable value, with stable key ordering. */
export async function stableHashHex(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const object = node as Record<string, unknown>;
    if (seen.has(object)) throw new Error('Cannot stable-stringify a cyclic structure');
    seen.add(object);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) out[key] = walk(object[key]);
    seen.delete(object);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Constant-time comparison for equal-length secrets. Length is not secret here. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// HMAC / hashing helpers
// ---------------------------------------------------------------------------

/** WebCrypto key usages. `workers-types` types the parameter as `string[]`. */
export type CryptoKeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

async function importHmacKey(secret: string | Uint8Array, usage: CryptoKeyUsage[]): Promise<CryptoKey> {
  const raw = typeof secret === 'string' ? utf8(secret) : secret;
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

/** HMAC-SHA256 as lowercase hex. Used for session ids, challenge hashes, CSRF. */
export async function hmacHex(secret: string | Uint8Array, message: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, utf8(message) as unknown as BufferSource);
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 as base64url. Used for pairing proofs and cookie signatures. */
export async function hmacBase64Url(secret: string | Uint8Array, message: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, utf8(message) as unknown as BufferSource);
  return toBase64Url(new Uint8Array(signature));
}

// ---------------------------------------------------------------------------
// Envelope encryption for site credentials at rest
// ---------------------------------------------------------------------------

/**
 * Envelope format: `v1.<iv-b64url>.<ciphertext-b64url>`.
 * AES-256-GCM with a fresh 96-bit IV per value, authenticated with the site id
 * as additional data so a ciphertext cannot be moved between rows.
 */
const ENVELOPE_VERSION = 'v1';

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(base64Key);
  } catch {
    raw = fromBase64Url(base64Key.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  if (raw.length !== 32) {
    throw new Error('SITE_CREDENTIAL_KEY must decode to exactly 32 bytes (base64 of 32 random bytes)');
  }
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
}

export async function encryptSecret(base64Key: string, plaintext: string, additionalData = ''): Promise<string> {
  if (plaintext === '') return '';
  const key = await importAesKey(base64Key);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: utf8(additionalData) as unknown as BufferSource
    },
    key,
    utf8(plaintext) as unknown as BufferSource
  );
  return `${ENVELOPE_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(base64Key: string, envelope: string, additionalData = ''): Promise<string> {
  if (envelope === '') return '';
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('Unsupported credential envelope');
  }
  const key = await importAesKey(base64Key);
  const iv = fromBase64Url(parts[1] as string);
  const ciphertext = fromBase64Url(parts[2] as string);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: utf8(additionalData) as unknown as BufferSource
    },
    key,
    ciphertext as unknown as BufferSource
  );
  return fromUtf8(plaintext);
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

const PBKDF2_HASH = 'SHA-256';
const PBKDF2_SALT_BYTES = 16;

/** Returns `pbkdf2-sha256$<iterations>$<salt-b64url>$<derived-b64url>`. */
export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(PBKDF2_SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number.parseInt(parts[1] as string, 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(parts[2] as string);
    expected = fromBase64Url(parts[3] as string);
  } catch {
    return false;
  }
  const derived = await derive(password, salt, iterations, expected.length);
  return constantTimeEqual(toBase64Url(derived), toBase64Url(expected));
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length = 32
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', utf8(password) as unknown as BufferSource, 'PBKDF2', false, [
    'deriveBits'
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: PBKDF2_HASH
    },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}
