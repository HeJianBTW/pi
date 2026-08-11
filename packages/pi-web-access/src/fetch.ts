import {
  assertPublicHttpUrl,
  type DnsLookup,
  hostFromUrl,
  safeFetch,
  type TrustedHosts,
} from '@amaster.ai/pi-shared';
import TurndownService from 'turndown';
import { resolveFetchProvider } from './config.js';
import type { FetchResponse } from './providers/index.js';
import { getProvider } from './providers/index.js';
import type { WebToolSettings } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const JINA_READER_BASE = 'https://r.jina.ai';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type WebFetchParams = { url: string };
export type WebFetchResponse = FetchResponse;

/** Hosts from user-configured provider baseUrls — trusted for SSRF purposes. */
function trustedHostsFromSettings(settings: WebToolSettings): TrustedHosts {
  const hosts: string[] = [];
  for (const config of Object.values(settings.providers ?? {})) {
    const host = hostFromUrl(config?.baseUrl);
    if (host) hosts.push(host);
  }
  return hosts;
}

// ─── Jina Reader (free, supports JS rendering) ──────────────────────────────

async function fetchViaJina(url: string, timeoutMs: number): Promise<FetchResponse> {
  const endpoint = `${JINA_READER_BASE}/${url}`;

  const response = await fetch(endpoint, {
    headers: { Accept: 'text/markdown', 'X-No-Cache': 'true' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Jina Reader error ${response.status}`);
  }

  const markdown = await response.text();
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? url;

  return { url, title, content: markdown };
}

// ─── Local fallback (HTTP GET + turndown) ────────────────────────────────────

async function fetchLocal(
  url: string,
  timeoutMs: number,
  lookup?: DnsLookup,
  trustedHosts?: TrustedHosts,
): Promise<FetchResponse> {
  const response = await safeFetch(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
    { lookup, trustedHosts },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return { url, title: url, content: text };
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(text);

  const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? url;

  return { url, title, content: markdown };
}

// ─── Default fallback: Jina Reader → Local ───────────────────────────────────

async function fetchWithFallback(
  url: string,
  timeoutMs: number,
  lookup?: DnsLookup,
  trustedHosts?: TrustedHosts,
): Promise<FetchResponse> {
  await assertPublicHttpUrl(url, { lookup, trustedHosts });
  try {
    return await fetchViaJina(url, timeoutMs);
  } catch {
    return fetchLocal(url, timeoutMs, lookup, trustedHosts);
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function webFetch(
  params: WebFetchParams,
  settings: WebToolSettings,
  lookup?: DnsLookup,
): Promise<FetchResponse> {
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trustedHosts = trustedHostsFromSettings(settings);
  const resolved = resolveFetchProvider(settings);
  if (resolved) {
    await assertPublicHttpUrl(params.url, { lookup, trustedHosts });
    const provider = getProvider(resolved.id);
    if (!provider) {
      throw new Error(`Provider "${resolved.id}" is not registered.`);
    }
    return provider.fetch(params.url, resolved);
  }
  return fetchWithFallback(params.url, timeoutMs, lookup, trustedHosts);
}
