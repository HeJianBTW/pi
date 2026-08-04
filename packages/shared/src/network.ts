import { lookup as nodeLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookup = async (hostname) =>
  nodeLookup(hostname, { all: true, verbatim: true });
const localUseAddresses = new BlockList();
localUseAddresses.addSubnet('64:ff9b:1::', 48, 'ipv6');

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    return false;
  }
  return true;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return undefined;
  const value = Number.parseInt(hex[1]!, 16) * 65_536 + Number.parseInt(hex[2]!, 16);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;
  if (localUseAddresses.check(normalized, 'ipv6')) return false;
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    /^fe[c-f]/.test(normalized) ||
    normalized.startsWith('ff')
  ) {
    return false;
  }
  const mapped = mappedIpv4(normalized);
  return mapped ? isPublicIpv4(mapped) : true;
}

/**
 * Parse an outbound URL once using Node's WHATWG parser and require every DNS
 * answer to be globally routable. Call this again for every redirect target.
 */
async function resolvePublicHttpUrl(
  value: string | URL,
  lookup: DnsLookup = defaultLookup,
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost')
  ) {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Outbound URL must use a public HTTP(S) destination.');
  }
  return { url, addresses };
}

export async function assertPublicHttpUrl(
  value: string | URL,
  lookup: DnsLookup = defaultLookup,
): Promise<URL> {
  return (await resolvePublicHttpUrl(value, lookup)).url;
}

export async function safeFetch(
  value: string | URL,
  init: RequestInit = {},
  options: {
    lookup?: DnsLookup;
    maxRedirects?: number;
  } = {},
): Promise<Response> {
  const lookup = options.lookup ?? defaultLookup;
  const maxRedirects = options.maxRedirects ?? 5;
  let resolved = await resolvePublicHttpUrl(value, lookup);

  for (let redirects = 0; ; redirects++) {
    const response = await pinnedFetch(resolved.url, resolved.addresses[0]!, init);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects >= maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Outbound request exceeded the redirect limit.');
    }
    const next = new URL(location, resolved.url);
    await response.body?.cancel().catch(() => {});
    resolved = await resolvePublicHttpUrl(next, lookup);
  }
}

async function pinnedFetch(
  url: URL,
  target: { address: string; family: number },
  init: RequestInit,
): Promise<Response> {
  const method = init.method?.toUpperCase() ?? 'GET';
  if ((method === 'GET' || method === 'HEAD') && init.body) {
    throw new Error(`${method} outbound requests cannot include a body.`);
  }
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body !== 'string' &&
    !(init.body instanceof Uint8Array)
  ) {
    throw new Error('Safe outbound fetch requires a replayable string or byte body.');
  }

  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        signal: init.signal ?? undefined,
        family: target.family,
        lookup(_hostname, _options, callback) {
          callback(null, target.address, target.family);
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const body =
          method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolve(
          new Response(body, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end(init.body ?? undefined);
  });
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Remote response exceeds the size ceiling.');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Remote response exceeds the size ceiling.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
