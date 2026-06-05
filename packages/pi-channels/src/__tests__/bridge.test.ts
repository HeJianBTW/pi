import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const { ChatBridge } = await import('../bridge.js');

function createChild(stdoutText: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', exitCode);
  }, 0);
  return child;
}

describe('ChatBridge', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'MODEL',
      'DESKTOP_PORT',
      'PI_AGENT_WORKSPACE',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  test('runs pi prompt and sends reply with original metadata', async () => {
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'ping',
      metadata: { messageId: 'om_1', threadId: 'omt_1' },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--offline', '--no-session', '--no-extensions', '来自即时通讯的用户消息：\nping'],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenCalledWith({
        adapter: 'feishu',
        recipient: 'oc_chat',
        text: 'pong',
        metadata: { messageId: 'om_1', threadId: 'omt_1' },
      });
    });
  });

  test('registers the bridge provider when anthropic-compatible env is configured', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://credits.amaster.ai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_MODEL', 'kimi-k2.5');
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: 'ping',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawn).toHaveBeenCalledWith(
      'pi',
      [
        '-p',
        '--offline',
        '--no-session',
        '--no-extensions',
        '-e',
        expect.stringContaining('bridge-provider.js'),
        '--provider',
        'anthropic-compatible',
        '--model',
        'kimi-k2.5',
        '来自即时通讯的用户消息：\nping',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenCalledWith({
        adapter: 'feishu',
        recipient: 'oc_chat',
        text: 'pong',
      });
    });
  });

  test('persists channel turns to the local pi-agent session endpoint when available', async () => {
    vi.stubEnv('DESKTOP_PORT', '18146');
    vi.stubEnv('PI_AGENT_WORKSPACE', '/workspace');
    vi.stubEnv('ANTHROPIC_MODEL', 'kimi-k2.5');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://credits.amaster.ai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mockSpawn.mockReturnValue(createChild('pong'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat:thread_1',
      text: 'ping',
      metadata: { chatId: 'oc_chat', chatName: '项目群' },
    });

    await vi.waitFor(() => {
      const channelCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === 'http://127.0.0.1:18146/internal/channel-sessions/turn',
      );
      expect(channelCalls.length).toBeGreaterThanOrEqual(2);
    });
    const channelCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === 'http://127.0.0.1:18146/internal/channel-sessions/turn',
    );
    for (const call of channelCalls) {
      expect(call[0]).toBe('http://127.0.0.1:18146/internal/channel-sessions/turn');
      expect(call[1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-pi-agent-internal': 'channel-bridge',
          }),
          body: expect.any(String),
        }),
      );
    }
    const started = JSON.parse(
      String(
        channelCalls.find((call) => String(call[1]?.body).includes('"phase":"started"'))?.[1]?.body,
      ),
    );
    expect(started).toMatchObject({
      phase: 'started',
      sessionId: 'oc_chat',
      conversationId: 'oc_chat',
      title: '飞书 / 项目群',
      adapter: 'feishu',
      recipient: 'oc_chat',
      userMessage: 'ping',
      workspaceDir: '/workspace',
    });
    expect(started).not.toHaveProperty('assistantMessage');
    const body = JSON.parse(
      String(
        channelCalls.find((call) => {
          const raw = String(call[1]?.body);
          return raw.includes('"phase":"completed"') && raw.includes('"assistantMessage":"pong"');
        })?.[1]?.body,
      ),
    );
    expect(body).toMatchObject({
      phase: 'completed',
      sessionId: 'oc_chat',
      conversationId: 'oc_chat',
      title: '飞书 / 项目群',
      adapter: 'feishu',
      recipient: 'oc_chat',
      userMessage: 'ping',
      assistantMessage: 'pong',
      workspaceDir: '/workspace',
      model: {
        provider: 'anthropic-compatible',
        model: 'kimi-k2.5',
      },
    });
  });

  test('acks WeCom messages before running the prompt and finishes with the final reply', async () => {
    mockSpawn.mockReturnValue(createChild('done'));
    const registry = {
      getAdapter: vi.fn(() => ({ sendTyping: vi.fn(() => Promise.resolve()) })),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'wecom',
      sender: 'wr_group:user_1',
      text: '@amaster 测试',
      metadata: {
        chatId: 'wr_group',
        replyToMessageId: 'msg_x',
        wecomReplyFrame: { headers: { req_id: 'req_x' } },
      },
    });

    expect(registry.send).toHaveBeenNthCalledWith(1, {
      adapter: 'wecom',
      recipient: 'wr_group:user_1',
      text: '收到，正在处理...',
      metadata: {
        chatId: 'wr_group',
        replyToMessageId: 'msg_x',
        wecomReplyFrame: { headers: { req_id: 'req_x' } },
        wecomReplyFinish: false,
      },
    });
    await vi.waitFor(() => {
      expect(registry.send).toHaveBeenNthCalledWith(2, {
        adapter: 'wecom',
        recipient: 'wr_group:user_1',
        text: 'done',
        metadata: {
          chatId: 'wr_group',
          replyToMessageId: 'msg_x',
          wecomReplyFrame: { headers: { req_id: 'req_x' } },
        },
      });
    });
  });

  test('handles built-in /status without spawning pi', async () => {
    const registry = {
      getAdapter: vi.fn(),
      send: vi.fn(() => Promise.resolve({ ok: true })),
    };
    const bridge = new ChatBridge({ enabled: true }, '/workspace', registry as never);
    bridge.start();

    await bridge.handleMessage({
      adapter: 'feishu',
      sender: 'oc_chat',
      text: '/status',
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: expect.stringContaining('Channel bridge status'),
    });
  });
});
