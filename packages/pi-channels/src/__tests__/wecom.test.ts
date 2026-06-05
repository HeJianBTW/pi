import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createWeComAdapter } from '../adapters/wecom.js';

type Listener = (...args: any[]) => void;

const mock = vi.hoisted(() => {
  const clients: FakeWSClient[] = [];

  class FakeWSClient {
    readonly options: Record<string, unknown>;
    readonly listeners = new Map<string, Set<Listener>>();
    readonly sent: Array<{ chatid: string; body: unknown }> = [];
    readonly streamReplies: Array<{
      frame: unknown;
      streamId: string;
      content: string;
      finish?: boolean;
    }> = [];
    connected = false;
    authError: Error | undefined;
    connectCount = 0;
    disconnectCount = 0;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }

    get isConnected(): boolean {
      return this.connected;
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    connect(): this {
      this.connectCount += 1;
      this.connected = true;
      queueMicrotask(() => {
        if (this.authError) this.emit('error', this.authError);
        else this.emit('authenticated');
      });
      return this;
    }

    disconnect(): void {
      this.disconnectCount += 1;
      this.connected = false;
    }

    async sendMessage(chatid: string, body: unknown): Promise<unknown> {
      this.sent.push({ chatid, body });
      return { headers: {}, body: {} };
    }

    async replyStream(
      frame: unknown,
      streamId: string,
      content: string,
      finish?: boolean,
    ): Promise<unknown> {
      this.streamReplies.push({
        frame,
        streamId,
        content,
        ...(finish !== undefined ? { finish } : {}),
      });
      return { headers: {}, body: {} };
    }
  }

  return { clients, FakeWSClient };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: mock.FakeWSClient,
}));

describe('WeCom adapter', () => {
  beforeEach(() => {
    mock.clients.length = 0;
  });

  test('sends markdown messages through the WeCom bot WebSocket client', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
    });

    await adapter.send?.({
      adapter: 'wecom',
      recipient: 'wr_group',
      text: 'hello',
      source: 'unit',
    });

    expect(mock.clients).toHaveLength(1);
    expect(mock.clients[0]!.options).toMatchObject({
      botId: 'bot_x',
      secret: 'secret',
      requestTimeout: 15_000,
    });
    expect(mock.clients[0]!.connectCount).toBe(1);
    expect(mock.clients[0]!.sent).toEqual([
      {
        chatid: 'wr_group',
        body: {
          msgtype: 'markdown',
          markdown: { content: '[unit]\nhello' },
        },
      },
    ]);
  });

  test('starts a long connection listener and emits incoming text messages', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
    });
    const incoming: unknown[] = [];

    await adapter.start?.((message) => {
      incoming.push(message);
    });

    mock.clients[0]!.emit('message.text', {
      headers: { req_id: 'req_x' },
      body: {
        msgid: 'msg_x',
        aibotid: 'bot_x',
        chatid: 'wr_group',
        chattype: 'group',
        from: { userid: 'zhangsan' },
        msgtype: 'text',
        text: { content: '帮我看一下' },
      },
    });

    expect(incoming).toEqual([
      {
        adapter: 'wecom',
        sender: 'wr_group:zhangsan',
        text: '帮我看一下',
        metadata: expect.objectContaining({
          messageId: 'msg_x',
          replyToMessageId: 'msg_x',
          botId: 'bot_x',
          chatId: 'wr_group',
          groupId: 'wr_group',
          chatType: 'group',
          senderId: 'zhangsan',
          wecomReplyFrame: {
            headers: { req_id: 'req_x' },
          },
        }),
      },
    ]);
  });

  test('replies to incoming messages through the callback frame', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
    });
    await adapter.send?.({
      adapter: 'wecom',
      recipient: 'wr_group:zhangsan',
      text: '收到',
      metadata: {
        replyToMessageId: 'msg_x',
        wecomReplyFrame: {
          headers: { req_id: 'req_x' },
        },
      },
    });

    expect(mock.clients[0]!.sent).toEqual([]);
    expect(mock.clients[0]!.streamReplies).toEqual([
      {
        frame: { headers: { req_id: 'req_x' } },
        streamId: 'amaster-msg_x',
        content: '收到',
        finish: true,
      },
    ]);
  });

  test('can keep a WeCom stream open for processing acknowledgements', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
    });
    await adapter.send?.({
      adapter: 'wecom',
      recipient: 'wr_group:zhangsan',
      text: '收到，正在处理...',
      metadata: {
        replyToMessageId: 'msg_x',
        wecomReplyFinish: false,
        wecomReplyFrame: {
          headers: { req_id: 'req_x' },
        },
      },
    });

    expect(mock.clients[0]!.streamReplies).toEqual([
      {
        frame: { headers: { req_id: 'req_x' } },
        streamId: 'amaster-msg_x',
        content: '收到，正在处理...',
        finish: false,
      },
    ]);
  });

  test('reports when another WeCom long connection kicks this one offline', async () => {
    const log = vi.fn();
    const adapter = createWeComAdapter(
      {
        type: 'wecom',
        botId: 'bot_x',
        secret: 'secret',
      },
      { log },
    );

    await adapter.start?.(() => undefined);
    mock.clients[0]!.emit('event.disconnected_event', {
      headers: { req_id: 'req_x' },
      body: {
        msgtype: 'event',
        event: { eventtype: 'disconnected_event' },
      },
    });

    expect(log).toHaveBeenCalledWith(
      'wecom-server-disconnected',
      {
        error: '企业微信长连接已被新的机器人连接顶下线，请停止其他同 Bot ID 的连接后重新连接。',
      },
      'ERROR',
    );
  });

  test('honors allowed chat and sender filters', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
      allowedChatIds: ['wr_allowed'],
      allowedSenderIds: ['lisi'],
    });
    const incoming: unknown[] = [];

    await adapter.start?.((message) => {
      incoming.push(message);
    });

    mock.clients[0]!.emit('message.text', {
      headers: {},
      body: {
        msgid: 'wrong_chat',
        aibotid: 'bot_x',
        chatid: 'wr_blocked',
        chattype: 'group',
        from: { userid: 'lisi' },
        msgtype: 'text',
        text: { content: 'blocked' },
      },
    });
    mock.clients[0]!.emit('message.text', {
      headers: {},
      body: {
        msgid: 'wrong_sender',
        aibotid: 'bot_x',
        chatid: 'wr_allowed',
        chattype: 'group',
        from: { userid: 'zhangsan' },
        msgtype: 'text',
        text: { content: 'blocked' },
      },
    });
    mock.clients[0]!.emit('message.text', {
      headers: {},
      body: {
        msgid: 'ok',
        aibotid: 'bot_x',
        chatid: 'wr_allowed',
        chattype: 'group',
        from: { userid: 'lisi' },
        msgtype: 'text',
        text: { content: 'allowed' },
      },
    });

    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ text: 'allowed' });
  });

  test('can be configured as outgoing-only', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'secret',
      eventMode: 'off',
    });

    expect(adapter.direction).toBe('outgoing');
    await adapter.start?.(() => undefined);
    expect(mock.clients[0]!.connectCount).toBe(0);
  });

  test('explains invalid bot credentials with the intelligent bot setup hint', async () => {
    const adapter = createWeComAdapter({
      type: 'wecom',
      botId: 'bot_x',
      secret: 'wrong',
    });
    mock.clients[0]!.authError = new Error(
      'Authentication failed: invalid bot_id or secret, more info at https://open.work.weixin.qq.com/devtool/query?e=853000 (code: 853000)',
    );

    await expect(
      adapter.send?.({ adapter: 'wecom', recipient: 'wr_group', text: 'hello' }),
    ).rejects.toThrow('企业微信智能机器人认证失败');
  });
});
