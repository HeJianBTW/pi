import { WeComApiError } from './errors.js';
import type { WeComAgentAccount, WeComTextTarget } from './types.js';

type AccessTokenCache = {
  value: string;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
};

type WeComJson = {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
  invaliduser?: string;
  invalidparty?: string;
  invalidtag?: string;
};

const tokenCaches = new Map<string, AccessTokenCache>();

function cacheKey(account: WeComAgentAccount): string {
  return `${account.baseUrl}:${account.corpId}:${account.agentId}:${account.secret}`;
}

async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const err = new WeComApiError({
      operation: 'network',
      category: 'network',
      errmsg: error instanceof Error ? error.message : String(error),
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<WeComJson> {
  return (await response.json().catch(() => ({}))) as WeComJson;
}

export class WeComAgentClient {
  private readonly tokenCache: AccessTokenCache;

  constructor(private readonly account: WeComAgentAccount) {
    let cache = tokenCaches.get(cacheKey(account));
    if (!cache) {
      cache = { value: '', expiresAt: 0, refreshPromise: null };
      tokenCaches.set(cacheKey(account), cache);
    }
    this.tokenCache = cache;
  }

  async getAccessToken(): Promise<string> {
    const cache = this.tokenCache;
    if (cache.value && Date.now() < cache.expiresAt) return cache.value;
    if (cache.refreshPromise) return cache.refreshPromise;

    cache.refreshPromise = (async () => {
      try {
        const url = new URL(`${this.account.baseUrl}/gettoken`);
        url.searchParams.set('corpid', this.account.corpId);
        url.searchParams.set('corpsecret', this.account.secret);
        const response = await fetchWithTimeout(url, undefined, this.account.network.timeoutMs);
        const data = await readJson(response);

        if (!response.ok || data.errcode !== 0 || !data.access_token) {
          throw new WeComApiError({
            operation: 'gettoken',
            errcode: data.errcode,
            errmsg: data.errmsg ?? response.statusText,
            status: response.status,
          });
        }

        const ttlSeconds = Math.max(
          (data.expires_in ?? 7200) - this.account.tokenRefreshBufferSeconds,
          60,
        );
        cache.value = data.access_token;
        cache.expiresAt = Date.now() + ttlSeconds * 1000;
        return cache.value;
      } finally {
        cache.refreshPromise = null;
      }
    })();

    return cache.refreshPromise;
  }

  async sendText(params: { target: WeComTextTarget; text: string; safe?: 0 | 1 }): Promise<void> {
    const accessToken = await this.getAccessToken();
    const useAppChat = Boolean(params.target.chatid);
    const endpoint = useAppChat ? 'appchat/send' : 'message/send';
    const response = await fetchWithTimeout(
      `${this.account.baseUrl}/${endpoint}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          useAppChat
            ? {
                chatid: params.target.chatid,
                msgtype: 'text',
                text: { content: params.text },
              }
            : {
                touser: params.target.touser,
                toparty: params.target.toparty,
                totag: params.target.totag,
                msgtype: 'text',
                agentid: this.account.agentId,
                text: { content: params.text },
                safe: params.safe ?? 0,
              },
        ),
      },
      this.account.network.timeoutMs,
    );
    const data = await readJson(response);

    if (!response.ok || data.errcode !== 0) {
      throw new WeComApiError({
        operation: useAppChat ? 'appchat/send' : 'message/send',
        errcode: data.errcode,
        errmsg: data.errmsg ?? response.statusText,
        status: response.status,
      });
    }

    if (data.invaliduser || data.invalidparty || data.invalidtag) {
      throw new WeComApiError({
        operation: useAppChat ? 'appchat/send' : 'message/send',
        errcode: data.errcode,
        errmsg: 'partial recipient failure',
        category: 'invalid_recipient',
        invalidUser: data.invaliduser,
        invalidParty: data.invalidparty,
        invalidTag: data.invalidtag,
      });
    }
  }
}
