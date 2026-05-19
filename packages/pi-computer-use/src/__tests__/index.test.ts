import { beforeEach, describe, expect, test, vi } from 'vitest';

// --- Mocks ---

const mockWsSend = vi.fn();
const mockWsClose = vi.fn();
const mockWsOn = vi.fn();
const mockWsOff = vi.fn();
let wsOpenCallback: (() => void) | null = null;
let _wsMessageCallback: ((data: string) => void) | null = null;

vi.mock('ws', () => ({
  default: class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    send = mockWsSend;
    close = mockWsClose;
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'open') wsOpenCallback = handler as () => void;
      if (event === 'message') _wsMessageCallback = handler as (data: string) => void;
      mockWsOn(event, handler);
    });
    off = mockWsOff;
    terminate = vi.fn();
    constructor() {
      setTimeout(() => wsOpenCallback?.(), 0);
    }
  },
}));

const mockSpawn = vi.fn((_cmd?: string, _args?: string[]) => ({
  exitCode: null,
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => mockSpawn(cmd, args),
}));

let mockConfigContent: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn((..._args: unknown[]) => {
      if (mockConfigContent !== null) return mockConfigContent;
      throw new Error('ENOENT');
    }),
  };
});

// --- Helpers ---

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
}

const registeredTools = new Map<string, RegisteredTool>();
const sessionStartHandlers: Array<() => Promise<void>> = [];
const sessionShutdownHandlers: Array<() => Promise<void>> = [];

const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => {
    registeredTools.set(tool.name, tool);
  }),
  on: vi.fn((event: string, handler: () => Promise<void>) => {
    if (event === 'session_start') sessionStartHandlers.push(handler);
    if (event === 'session_shutdown') sessionShutdownHandlers.push(handler);
  }),
};

const { default: computerUseExtension } = await import('../index.js');

function registerExtension(config?: Record<string, unknown>) {
  if (config) {
    mockConfigContent = JSON.stringify({ 'pi-computer-use': config });
  } else {
    mockConfigContent = null;
  }
  registeredTools.clear();
  sessionStartHandlers.length = 0;
  sessionShutdownHandlers.length = 0;

  computerUseExtension(mockPi as any);
}

// --- Tests ---

describe('computerUseExtension', () => {
  beforeEach(() => {
    registeredTools.clear();
    sessionStartHandlers.length = 0;
    sessionShutdownHandlers.length = 0;
    mockPi.registerTool.mockClear();
    mockPi.on.mockClear();
    mockWsSend.mockClear();
    mockWsClose.mockClear();
    mockSpawn.mockClear();
    wsOpenCallback = null;
    _wsMessageCallback = null;
  });

  test('registers session_start and session_shutdown handlers', () => {
    registerExtension();

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  test('registers computer_use tool', () => {
    registerExtension();

    expect(registeredTools.has('computer_use')).toBe(true);
  });

  describe('tool registration', () => {
    test('tool has correct name and description', () => {
      registerExtension();

      const tool = registeredTools.get('computer_use')!;
      expect(tool.name).toBe('computer_use');
      expect(tool.description).toContain('screenshot');
      expect(tool.description).toContain('click');
      expect(tool.description).toContain('type');
    });

    test('only registers a single tool', () => {
      registerExtension();

      expect(registeredTools.size).toBe(1);
    });
  });

  describe('config loading', () => {
    test('uses defaults when config.json is missing', () => {
      registerExtension();
      expect(registeredTools.size).toBe(1);
    });

    test('reads pi-computer-use section from config.json', () => {
      registerExtension({ mode: 'external', host: '192.168.1.100' });
      expect(registeredTools.size).toBe(1);
    });
  });

  describe('lifecycle (session_shutdown)', () => {
    test('no-ops when shutdown called without prior tool use', async () => {
      registerExtension();

      for (const handler of sessionShutdownHandlers) {
        await handler();
      }

      expect(mockWsClose).not.toHaveBeenCalled();
    });
  });
});

describe('action dispatch', () => {
  test('click sends left_click command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'click',
      x: 100,
      y: 200,
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('left_click', { x: 100, y: 200 });
    expect(result).toContain('100');
    expect(result).toContain('200');
  });

  test('right click sends right_click command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    await dispatchAction(mockClient as any, {
      type: 'click',
      x: 50,
      y: 75,
      button: 'right',
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('right_click', { x: 50, y: 75 });
  });

  test('type sends type_text command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'type',
      text: 'hello',
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('type_text', { text: 'hello' });
    expect(result).toContain('hello');
  });

  test('keypress sends hotkey command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    await dispatchAction(mockClient as any, {
      type: 'keypress',
      keys: ['ctrl', 'c'],
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('hotkey', { keys: ['ctrl', 'c'] });
  });

  test('scroll sends scroll command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    await dispatchAction(mockClient as any, {
      type: 'scroll',
      scroll_x: 0,
      scroll_y: -3,
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('scroll', { x: 0, y: -3 });
  });

  test('run_command sends run_command and returns output', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({ stdout: 'file.txt', stderr: '' })),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'run_command',
      command: 'ls',
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('run_command', { command: 'ls' });
    expect(result).toContain('file.txt');
  });

  test('wait sleeps for 1 second', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const start = Date.now();
    await dispatchAction(mockClient as any, { type: 'wait' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(mockClient.sendCommand).not.toHaveBeenCalled();
  });

  test('double_click sends double_click command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'double_click',
      x: 300,
      y: 400,
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('double_click', { x: 300, y: 400 });
    expect(result).toContain('300');
    expect(result).toContain('400');
  });

  test('move sends move_cursor command', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'move',
      x: 500,
      y: 600,
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('move_cursor', { x: 500, y: 600 });
    expect(result).toContain('500');
    expect(result).toContain('600');
  });

  test('drag sends drag command with path and button', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const path: Array<[number, number]> = [
      [10, 10],
      [50, 50],
      [100, 100],
    ];
    const result = await dispatchAction(mockClient as any, {
      type: 'drag',
      path,
      button: 'left',
    });

    expect(mockClient.sendCommand).toHaveBeenCalledWith('drag', { path, button: 'left' });
    expect(result).toContain('3');
  });

  test('run_command with stderr includes stderr in output', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() =>
        Promise.resolve({ stdout: 'output', stderr: 'warning: deprecated' }),
      ),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'run_command',
      command: 'make build',
    });

    expect(result).toContain('output');
    expect(result).toContain('warning: deprecated');
  });

  test('run_command with no output returns fallback message', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, {
      type: 'run_command',
      command: 'true',
    });

    expect(result).toBe('Command executed (no output)');
  });

  test('screenshot action returns undefined', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    const result = await dispatchAction(mockClient as any, { type: 'screenshot' });
    expect(result).toBeUndefined();
    expect(mockClient.sendCommand).not.toHaveBeenCalled();
  });

  test('scroll defaults x and y to 0', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    await dispatchAction(mockClient as any, { type: 'scroll' });
    expect(mockClient.sendCommand).toHaveBeenCalledWith('scroll', { x: 0, y: 0 });
  });

  test('unknown action throws', async () => {
    const { dispatchAction } = await import('../actions.js');
    const mockClient = {
      sendCommand: vi.fn(() => Promise.resolve({})),
      screenshot: vi.fn(),
    };

    await expect(dispatchAction(mockClient as any, { type: 'unknown_action' })).rejects.toThrow(
      'Unknown action type',
    );
  });
});

describe('config', () => {
  test('provides sane defaults', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig();
    expect(config.mode).toBe('managed');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8000);
    expect(config.command).toBe('uvx');
    expect(config.package).toBe('cua-computer-server');
    expect(config.autoScreenshot).toBe(true);
  });

  test('merges user config over defaults', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({ mode: 'external', host: '10.0.0.1', port: 9000 });
    expect(config.mode).toBe('external');
    expect(config.host).toBe('10.0.0.1');
    expect(config.port).toBe(9000);
    expect(config.command).toBe('uvx');
  });

  test('preserves visionModel config', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({
      visionModel: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(config.visionModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  test('preserves apiKey and vmName for cloud mode', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({
      mode: 'external',
      apiKey: 'my-secret-key',
      vmName: 'production-vm',
    });
    expect(config.apiKey).toBe('my-secret-key');
    expect(config.vmName).toBe('production-vm');
  });

  test('autoScreenshot can be disabled', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({ autoScreenshot: false });
    expect(config.autoScreenshot).toBe(false);
  });

  test('loadConfigFromFile returns empty on missing file', async () => {
    mockConfigContent = null;
    const { loadConfigFromFile } = await import('../config.js');
    const config = loadConfigFromFile();
    expect(config).toEqual({});
  });

  test('loadConfigFromFile reads pi-computer-use section', async () => {
    mockConfigContent = JSON.stringify({
      'pi-computer-use': { mode: 'external', port: 4000 },
    });
    const { loadConfigFromFile } = await import('../config.js');
    const config = loadConfigFromFile();
    expect(config).toEqual({ mode: 'external', port: 4000 });
  });
});
