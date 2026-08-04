import { describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl, type DnsLookup, readResponseBytes, safeFetch } from '../network.js';

const publicLookup: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('network', () => {
  it.each([
    'http://127.0.0.1/private',
    'http://0.0.0.0/private',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.1/private',
    'http://[::1]/private',
    'http://[fec0::1]/private',
    'http://[64:ff9b:1::a00:1]/private',
    'http://[::ffff:127.0.0.1]/private',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'file:///etc/passwd',
  ])('rejects non-public destination %s', async (url) => {
    await expect(assertPublicHttpUrl(url, publicLookup)).rejects.toThrow(/public HTTP/i);
  });

  it('rejects a hostname when DNS returns a private address', async () => {
    const privateLookup: DnsLookup = async () => [{ address: '192.168.1.20', family: 4 }];
    await expect(
      assertPublicHttpUrl('https://internal.example/path', privateLookup),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('allows a public HTTP URL', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/path', publicLookup),
    ).resolves.toMatchObject({ hostname: 'example.com', protocol: 'https:' });
    await expect(
      assertPublicHttpUrl('http://[::ffff:93.184.216.34]/path', publicLookup),
    ).resolves.toMatchObject({ hostname: '[::ffff:5db8:d822]' });
  });

  it('does not let a wrapped global fetch bypass DNS validation', async () => {
    const originalFetch = globalThis.fetch;
    const wrappedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('unsafe'));
    globalThis.fetch = wrappedFetch;

    try {
      await expect(safeFetch('https://does-not-resolve.invalid/private')).rejects.toThrow(
        /public HTTP/i,
      );
      expect(wrappedFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels and rejects a response body that exceeds the byte ceiling', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseBytes(response, 10)).rejects.toThrow(/size ceiling/i);
    expect(cancelled).toBe(true);
  });
});
