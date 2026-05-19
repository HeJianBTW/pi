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
      ['-p', '--no-session', '--no-extensions', 'ping'],
      expect.objectContaining({ cwd: '/workspace' }),
    );
    expect(registry.send).toHaveBeenCalledWith({
      adapter: 'feishu',
      recipient: 'oc_chat',
      text: 'pong',
      metadata: { messageId: 'om_1', threadId: 'omt_1' },
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
