import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadChannelConfig: vi.fn(() => ({
    adapters: {
      webhook: { type: 'webhook' },
    },
    routes: {
      ops: { adapter: 'webhook', recipient: 'https://example.test/hook' },
    },
    bridge: { enabled: false },
  })),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const events = new Map<string, (raw: unknown) => unknown>();
const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
const commands = new Map<
  string,
  { handler: (args: string | undefined, ctx: unknown) => Promise<void> }
>();

const mockPi = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(event, handler);
  }),
  events: {
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (raw: unknown) => unknown) => {
      events.set(event, handler);
    }),
  },
  registerTool: vi.fn(
    (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
  ),
  registerCommand: vi.fn(
    (
      name: string,
      command: { handler: (args: string | undefined, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
  ),
};

const { default: piChannelsExtension } = await import('../index.js');

function mockCtx() {
  return {
    cwd: '/workspace',
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

describe('piChannelsExtension', () => {
  beforeEach(() => {
    handlers.clear();
    events.clear();
    tools.clear();
    commands.clear();
    mockPi.on.mockClear();
    mockPi.events.emit.mockClear();
    mockPi.events.on.mockClear();
    mockPi.registerTool.mockClear();
    mockPi.registerCommand.mockClear();
    vi.unstubAllGlobals();
  });

  test('registers lifecycle handlers, events, command, and notify tool', () => {
    piChannelsExtension(mockPi as never);

    expect(handlers.has('session_start')).toBe(true);
    expect(handlers.has('session_shutdown')).toBe(true);
    expect(events.has('channel:send')).toBe(true);
    expect(events.has('channel:register')).toBe(true);
    expect(events.has('channel:list')).toBe(true);
    expect(commands.has('channel')).toBe(true);
    expect(tools.has('notify')).toBe(true);
  });

  test('notify list shows configured adapters and routes after session_start', async () => {
    piChannelsExtension(mockPi as never);
    const ctx = mockCtx();
    await handlers.get('session_start')?.({}, ctx);

    const result = (await tools.get('notify')?.execute('call-1', { action: 'list' })) as {
      content: Array<{ text: string }>;
    };

    expect(result.content[0]!.text).toContain('webhook adapter');
    expect(result.content[0]!.text).toContain('ops route -> webhook -> https://example.test/hook');
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-channels', 'channels: 1');
  });

  test('notify send routes through webhook aliases', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());

    const result = (await tools.get('notify')?.execute('call-1', {
      action: 'send',
      adapter: 'ops',
      text: 'hello',
      source: 'unit',
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe('Sent via "ops".');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/hook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((request as RequestInit).body))).toEqual({
      text: 'hello',
      source: 'unit',
      timestamp: expect.any(String),
    });
  });

  test('channel:register can add runtime adapters and channel:send can use them', async () => {
    const send = vi.fn(() => Promise.resolve());
    const callback = vi.fn();

    piChannelsExtension(mockPi as never);
    await handlers.get('session_start')?.({}, mockCtx());
    events.get('channel:register')?.({
      name: 'custom',
      adapter: { direction: 'outgoing', send },
      callback,
    });

    expect(callback).toHaveBeenCalledWith(true);
    await events.get('channel:send')?.({
      adapter: 'custom',
      recipient: 'room',
      text: 'hello',
      callback,
    });

    expect(send).toHaveBeenCalledWith({
      adapter: 'custom',
      recipient: 'room',
      text: 'hello',
    });
  });
});
