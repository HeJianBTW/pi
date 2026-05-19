import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createWeComAdapter, type WeComApiError } from '../adapters/wecom.js';

describe('WeCom adapter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetches access token and sends app text messages', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/gettoken')) {
        expect(href).toContain('corpid=ww_corp');
        expect(href).toContain('corpsecret=secret');
        return new Response(
          JSON.stringify({ errcode: 0, access_token: 'access-token', expires_in: 7200 }),
          { status: 200 },
        );
      }

      expect(href).toBe(
        'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=access-token',
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        touser: 'zhangsan',
        msgtype: 'text',
        agentid: 100001,
        text: { content: '[unit]\nhello' },
        safe: 0,
      });
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWeComAdapter({
      type: 'wecom',
      corpId: 'ww_corp',
      agentId: '100001',
      secret: 'secret',
    });

    await adapter.send?.({
      adapter: 'wecom',
      recipient: 'zhangsan',
      text: 'hello',
      source: 'unit',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('resolves party and tag recipient prefixes', async () => {
    const payloads: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('/gettoken')) {
          return new Response(JSON.stringify({ errcode: 0, access_token: 'token' }), {
            status: 200,
          });
        }
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
      }),
    );

    const adapter = createWeComAdapter({
      type: 'wecom',
      corpId: 'ww_party',
      agentId: 100001,
      secret: 'secret',
    });

    await adapter.send?.({ adapter: 'wecom', recipient: 'party:2', text: 'party' });
    await adapter.send?.({ adapter: 'wecom', recipient: 'tag:7', text: 'tag' });

    expect(payloads).toEqual([
      expect.objectContaining({ toparty: '2' }),
      expect.objectContaining({ totag: '7' }),
    ]);
  });

  test('sends appchat messages with chat recipient prefixes', async () => {
    const payloads: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('/gettoken')) {
          return new Response(JSON.stringify({ errcode: 0, access_token: 'chat-token' }), {
            status: 200,
          });
        }
        expect(href).toBe(
          'https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=chat-token',
        );
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
      }),
    );

    const adapter = createWeComAdapter({
      type: 'wecom',
      corpId: 'ww_chat',
      agentId: 100002,
      secret: 'secret',
    });

    await adapter.send?.({ adapter: 'wecom', recipient: 'appchat:chat-1', text: 'hello chat' });

    expect(payloads).toEqual([
      {
        chatid: 'chat-1',
        msgtype: 'text',
        text: { content: 'hello chat' },
      },
    ]);
  });

  test('shares one token refresh across concurrent sends', async () => {
    let tokenRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('/gettoken')) {
          tokenRequests += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return new Response(JSON.stringify({ errcode: 0, access_token: 'shared-token' }), {
            status: 200,
          });
        }
        expect(href).toContain('access_token=shared-token');
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
      }),
    );

    const adapter = createWeComAdapter({
      type: 'wecom',
      corpId: 'ww_concurrent',
      agentId: 100003,
      secret: 'secret',
    });

    await Promise.all([
      adapter.send?.({ adapter: 'wecom', recipient: 'user:a', text: 'a' }),
      adapter.send?.({ adapter: 'wecom', recipient: 'user:b', text: 'b' }),
    ]);

    expect(tokenRequests).toBe(1);
  });

  test('classifies trusted IP failures with an actionable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        if (href.includes('/gettoken')) {
          return new Response(JSON.stringify({ errcode: 0, access_token: 'ip-token' }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ errcode: 60020, errmsg: 'not allow to access from your ip' }),
          { status: 200 },
        );
      }),
    );

    const adapter = createWeComAdapter({
      type: 'wecom',
      corpId: 'ww_ip',
      agentId: 100004,
      secret: 'secret',
    });

    await expect(
      adapter.send?.({ adapter: 'wecom', recipient: 'user:zhangsan', text: 'hello' }),
    ).rejects.toMatchObject({
      name: 'WeComApiError',
      errcode: 60020,
      category: 'ip_whitelist',
    } satisfies Partial<WeComApiError>);
  });
});
