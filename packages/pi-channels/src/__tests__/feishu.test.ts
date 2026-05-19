import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockCreateMessage = vi.fn();
const mockReplyMessage = vi.fn();
const mockChannelOn = vi.fn();
const mockChannelConnect = vi.fn();
const mockChannelDisconnect = vi.fn();
let channelHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: {
    SelfBuild: 0,
    ISV: 1,
  },
  Domain: {
    Feishu: 0,
    Lark: 1,
  },
  LoggerLevel: {
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
  },
  Client: class MockClient {
    im = {
      message: {
        create: mockCreateMessage,
        reply: mockReplyMessage,
      },
    };
  },
  EventDispatcher: class MockEventDispatcher {
    register = vi.fn(() => this);
  },
  adaptDefault: vi.fn(() => vi.fn()),
  createLarkChannel: vi.fn(() => ({
    on: mockChannelOn.mockImplementation(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        channelHandlers.set(name, handler);
      },
    ),
    connect: mockChannelConnect,
    disconnect: mockChannelDisconnect,
  })),
}));

const { createFeishuAdapter } = await import('../adapters/feishu.js');
const lark = await import('@larksuiteoapi/node-sdk');

describe('Feishu adapter', () => {
  beforeEach(() => {
    mockCreateMessage.mockReset();
    mockReplyMessage.mockReset();
    mockChannelOn.mockReset();
    mockChannelConnect.mockReset();
    mockChannelDisconnect.mockReset();
    channelHandlers = new Map();
    mockCreateMessage.mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
    mockReplyMessage.mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
  });

  test('sends a text message with official SDK Client.im.message.create', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'hello',
      source: 'test',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'text',
        content: JSON.stringify({ text: '[test]\nhello' }),
      },
    });
  });

  test('uses explicit receive id prefix when provided', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'open_id:ou_user',
      text: 'hello',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_user',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    });
  });

  test('replies to the original message when bridge metadata carries messageId', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'off',
    });

    await adapter.send?.({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'agent reply',
      metadata: {
        messageId: 'om_inbound',
        threadId: 'omt_thread',
      },
    });

    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockReplyMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_inbound' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'agent reply' }),
        reply_in_thread: true,
      },
    });
  });

  test('connects the SDK websocket channel and emits accepted incoming messages', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      allowedChatIds: ['oc_allowed'],
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);

    expect(lark.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_xxx',
        appSecret: 'secret',
        transport: 'websocket',
        policy: expect.objectContaining({
          requireMention: true,
          groupAllowlist: ['oc_allowed'],
        }),
      }),
    );
    expect(mockChannelConnect).toHaveBeenCalledTimes(1);

    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_allowed',
      chatType: 'group',
      senderId: 'ou_user',
      senderName: 'Ada',
      content: 'ping',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: 1,
    });

    expect(onMessage).toHaveBeenCalledWith({
      adapter: 'feishu',
      sender: 'oc_allowed',
      text: 'ping',
      metadata: expect.objectContaining({
        messageId: 'om_1',
        chatId: 'oc_allowed',
        chatType: 'group',
        senderId: 'ou_user',
      }),
    });
  });

  test('filters group websocket messages that do not mention the bot', async () => {
    const adapter = createFeishuAdapter({
      type: 'feishu',
      appId: 'cli_xxx',
      appSecret: 'secret',
      eventMode: 'websocket',
      respondToMentionsOnly: true,
    });
    const onMessage = vi.fn();

    await adapter.start?.(onMessage);
    channelHandlers.get('message')?.({
      messageId: 'om_1',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_user',
      content: 'ignored',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1,
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
});
