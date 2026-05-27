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
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('close', exitCode);
  });
  return child;
}

describe('ChatBridge', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--offline', '--no-session', '--no-extensions', 'ping'],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    expect(registry.send).toHaveBeenCalledWith({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'pong',
      metadata: { messageId: 'om_1', threadId: 'omt_1' },
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
        'ping',
      ],
      expect.objectContaining({ cwd: '/workspace' }),
    );
  });

  test('persists channel turns to the local pi-agent session endpoint when available', async () => {
    vi.stubEnv('DESKTOP_PORT', '18146');
    vi.stubEnv('PI_AGENT_WORKSPACE', '/workspace');
    vi.stubEnv('ANTHROPIC_MODEL', 'kimi-k2.5');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://credits.amaster.ai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18146/internal/channel-sessions/turn',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-pi-agent-internal': 'channel-bridge',
        }),
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
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
