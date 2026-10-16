/**
 * SSRF policy tests.
 *
 * The runtime flag `global_fetch_strictly_public` is the backstop, but it cannot
 * be relied on alone: a bug that lets a private hostname through would still be
 * caught here, and this policy is what produces the user-facing refusal message.
 */

import { describe, expect, it } from 'vitest';
import { checkSiteUrl, normalizeBaseUrl, safeFetch } from '../../src/shared/ssrf.js';

const PROD = { allowInsecure: false };
const DEV = { allowInsecure: true };

function rejects(input: string, policy = PROD): string {
  const result = checkSiteUrl(input, policy);
  expect(result.ok, `${input} should be rejected`).toBe(false);
  return result.reason as string;
}

function accepts(input: string, policy = PROD): URL {
  const result = checkSiteUrl(input, policy);
  expect(result.ok, `${input} should be accepted (${result.reason ?? ''})`).toBe(true);
  return result.url as URL;
}

describe('scheme and shape', () => {
  it('accepts a normal https site', () => {
    expect(accepts('https://www.example.com').hostname).toBe('www.example.com');
  });

  it('accepts a site in a subdirectory', () => {
    expect(normalizeBaseUrl(accepts('https://example.com/blog/'))).toBe('https://example.com/blog');
  });

  it('rejects plain http for a public host', () => {
    expect(rejects('http://example.com')).toContain('must use https');
  });

  it('rejects embedded credentials', () => {
    expect(rejects('https://user:pass@example.com')).toContain('credentials');
  });

  it('rejects a fragment', () => {
    expect(rejects('https://example.com/#x')).toContain('fragment');
  });

  it('rejects non-http protocols', () => {
    expect(rejects('ftp://example.com')).toContain('https');
    expect(rejects('file:///etc/passwd')).toContain('https');
    expect(rejects('gopher://example.com')).toContain('https');
  });

  it('rejects a relative or unparseable value', () => {
    expect(rejects('not a url')).toContain('valid absolute URL');
    expect(rejects('')).toContain('empty');
  });
});

describe('loopback handling', () => {
  it('refuses loopback in production', () => {
    expect(rejects('https://127.0.0.1')).toContain('development mode');
    expect(rejects('https://localhost')).toContain('development mode');
    expect(rejects('http://[::1]:8080')).toContain('development mode');
  });

  it('allows loopback only when the development flag is set', () => {
    expect(accepts('http://127.0.0.1:8080', DEV).port).toBe('8080');
    expect(accepts('http://localhost:8080', DEV).hostname).toBe('localhost');
    expect(accepts('https://127.0.0.1', DEV).hostname).toBe('127.0.0.1');
  });

  it('still refuses a LAN address in development mode', () => {
    expect(rejects('http://192.168.1.50', DEV)).toContain('private or reserved');
    expect(rejects('http://10.0.0.5', DEV)).toContain('private or reserved');
  });
});

describe('IPv4 literals', () => {
  const blocked = [
    'https://0.0.0.0',
    'https://10.1.2.3',
    'https://100.64.0.1',
    'https://169.254.169.254',
    'https://172.16.0.1',
    'https://172.31.255.255',
    'https://192.0.0.1',
    'https://192.168.0.1',
    'https://198.18.0.1',
    'https://224.0.0.1',
    'https://240.0.0.1',
    'https://255.255.255.255'
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(rejects(url)).toContain('private or reserved');
    });
  }

  it('allows a public IPv4 literal', () => {
    expect(accepts('https://93.184.216.34').hostname).toBe('93.184.216.34');
  });

  it('blocks obfuscated integer and hex forms, which the URL parser normalizes', () => {
    // The WHATWG URL parser turns these into dotted-quad before any policy code
    // sees them, which is why the range checks below can rely on `hostname`.
    expect(new URL('http://2130706433').hostname).toBe('127.0.0.1');
    expect(new URL('http://0x7f000001').hostname).toBe('127.0.0.1');
    expect(new URL('http://2852039166').hostname).toBe('169.254.169.254');

    // Loopback is refused for a different (more specific) reason.
    expect(checkSiteUrl('http://2130706433', PROD).ok).toBe(false);
    expect(checkSiteUrl('http://0x7f000001', PROD).ok).toBe(false);
    expect(rejects('http://2852039166')).toContain('private or reserved');
  });

  it('blocks a decimal-encoded metadata address', () => {
    expect(rejects('http://169.254.169.254/latest/meta-data/')).toContain('private or reserved');
  });
});

describe('IPv6 literals', () => {
  const blocked = [
    'https://[::]',
    'https://[fc00::1]',
    'https://[fd12:3456::1]',
    'https://[fe80::1]',
    'https://[ff02::1]',
    'https://[2001:db8::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:169.254.169.254]',
    'https://[64:ff9b::127.0.0.1]',
    'https://[2002:7f00:0001::1]'
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(rejects(url)).toContain('private or reserved');
    });
  }

  it('allows a public IPv6 literal', () => {
    expect(accepts('https://[2606:4700:4700::1111]').hostname).toBe('[2606:4700:4700::1111]');
  });

  it('rejects a zone identifier outright', () => {
    // `new URL()` refuses a zone id, so this never reaches the range checks.
    expect(checkSiteUrl('https://[fe80::1%25eth0]', PROD).ok).toBe(false);
    // Without the zone id the same address is caught by the link-local range.
    expect(rejects('https://[fe80::1]')).toContain('private or reserved');
  });
});

describe('internal hostnames', () => {
  const blocked = [
    'https://localhost',
    'https://api.localhost',
    'https://printer.local',
    'https://vault.internal',
    'https://service.intranet',
    'https://x.home.arpa',
    'https://metadata.google.internal',
    'https://instance-data'
  ];

  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      const reason = rejects(url);
      expect(reason === 'Site URL resolves to an internal hostname.' || reason.includes('development mode')).toBe(true);
    });
  }

  it('still allows a public hostname that merely contains a blocked word', () => {
    expect(accepts('https://localhost.example.com').hostname).toBe('localhost.example.com');
    expect(accepts('https://internal.example.com').hostname).toBe('internal.example.com');
  });
});

describe('redirect handling in safeFetch', () => {
  it('revalidates every redirect hop and refuses one that points inward', async () => {
    const calls: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    };

    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      await expect(safeFetch(new URL('https://example.com/'), PROD, { maxRedirects: 3 })).rejects.toThrow(
        /private or reserved/
      );
      expect(calls).toEqual(['https://example.com/']);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('follows a bounded number of redirects and stops', async () => {
    let hops = 0;
    const fakeFetch = async (): Promise<Response> => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${hops}` } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      await expect(safeFetch(new URL('https://example.com/'), PROD, { maxRedirects: 2 })).rejects.toThrow(
        /too many redirects/
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects a response larger than the configured cap', async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'text/plain' } });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      await expect(safeFetch(new URL('https://example.com/'), PROD, { maxBytes: 100 })).rejects.toThrow(
        /maximum accepted size/
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
