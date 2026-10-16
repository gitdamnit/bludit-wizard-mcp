import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  fromBase64Url,
  hashPassword,
  hmacBase64Url,
  hmacHex,
  newId,
  randomToken,
  sha256Hex,
  stableHashHex,
  stableStringify,
  toBase64Url,
  verifyPassword
} from '../../src/shared/crypto.js';

const KEY = toBase64Url(new Uint8Array(32).fill(7));

describe('random tokens', () => {
  it('produces the requested entropy and is URL-safe', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(token)).toHaveLength(32);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken(16)));
    expect(tokens.size).toBe(200);
  });

  it('builds prefixed identifiers', () => {
    expect(newId('site')).toMatch(/^site_[A-Za-z0-9_-]{24}$/);
  });
});

describe('hashing', () => {
  it('hashes deterministically and distinctly', async () => {
    expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
    expect(await sha256Hex('abc')).toHaveLength(64);
  });

  it('orders object keys so semantically equal payloads hash equally', async () => {
    expect(await stableHashHex({ b: 1, a: 2 })).toBe(await stableHashHex({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
  });

  it('refuses a cyclic structure rather than looping forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/cyclic/);
  });

  it('computes HMACs in both encodings', async () => {
    expect(await hmacHex('secret', 'message')).toHaveLength(64);
    expect(await hmacHex('secret', 'message')).not.toBe(await hmacHex('secret', 'message '));
    expect(fromBase64Url(await hmacBase64Url('secret', 'message'))).toHaveLength(32);
  });

  it('compares in constant time semantics', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('credential encryption', () => {
  it('round-trips a secret', async () => {
    const envelope = await encryptSecret(KEY, 'super-secret-token', 'site_1');
    expect(envelope).toMatch(/^v1\./);
    expect(envelope).not.toContain('super-secret-token');
    expect(await decryptSecret(KEY, envelope, 'site_1')).toBe('super-secret-token');
  });

  it('binds the ciphertext to its additional data', async () => {
    const envelope = await encryptSecret(KEY, 'value', 'site_1');
    await expect(decryptSecret(KEY, envelope, 'site_2')).rejects.toThrow();
  });

  it('fails with the wrong key', async () => {
    const other = toBase64Url(new Uint8Array(32).fill(9));
    const envelope = await encryptSecret(KEY, 'value', 'site_1');
    await expect(decryptSecret(other, envelope, 'site_1')).rejects.toThrow();
  });

  it('uses a fresh IV each time, so identical values differ on disk', async () => {
    const a = await encryptSecret(KEY, 'same', 'site_1');
    const b = await encryptSecret(KEY, 'same', 'site_1');
    expect(a).not.toBe(b);
  });

  it('represents an empty secret as an empty string', async () => {
    expect(await encryptSecret(KEY, '', 'site_1')).toBe('');
    expect(await decryptSecret(KEY, '', 'site_1')).toBe('');
  });

  it('rejects a malformed or unknown envelope', async () => {
    await expect(decryptSecret(KEY, 'v1.abc', 'site_1')).rejects.toThrow(/Unsupported/);
    await expect(decryptSecret(KEY, 'v9.a.b', 'site_1')).rejects.toThrow(/Unsupported/);
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(encryptSecret(toBase64Url(new Uint8Array(16)), 'x')).rejects.toThrow(/32 bytes/);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple', 1000);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password-value', 1000);
    const b = await hashPassword('same-password-value', 1000);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-value', a)).toBe(true);
    expect(await verifyPassword('same-password-value', b)).toBe(true);
  });

  it('rejects malformed stored values instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$abc$zz$zz')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$0$AAAA$AAAA')).toBe(false);
  });
});
