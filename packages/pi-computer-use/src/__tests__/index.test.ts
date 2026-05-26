import { beforeEach, describe, expect, test, vi } from 'vitest';

// Force darwin platform so permission-message assertions match macOS strings
Object.defineProperty(process, 'platform', { value: 'darwin' });

let mockCallToolFn: (name: string, args: Record<string, unknown>) => unknown = () => ({
  content: [{ type: 'text', text: 'Action executed.' }],
});

let mockClientConnectFn: () => Promise<void> = async () => {};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect() {
      return mockClientConnectFn();
    }
    async close() {}
    async listTools() {
      return {
        tools: [
          { name: 'screenshot', description: 'Take a screenshot', inputSchema: { type: 'object' } },
          {
            name: 'click',
            description: 'Click at coordinates',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
          },
          {
            name: 'type_text',
            description: 'Type text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
        nextCursor: undefined,
      };
    }
    async callTool(req: { name: string; arguments: Record<string, unknown> }) {
      return mockCallToolFn(req.name, req.arguments ?? {});
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onerror: ((error: Error) => void) | null = null;
  },
}));

let mockConfigContent: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn((..._args: unknown[]) => {
      if (mockConfigContent !== null) return mockConfigContent;
      throw new Error('ENOENT');
    }),
  };
});

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
const eventHandlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};

const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => {
    registeredTools.set(tool.name, tool);
  }),
  on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
    if (!eventHandlers[event]) eventHandlers[event] = [];
    eventHandlers[event].push(handler);
  }),
};

const mockNotify = vi.fn();
const mockCtx = {
  cwd: '/tmp',
  ui: { notify: mockNotify },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
};

const { default: computerUseExtension } = await import('../index.js');

async function initExtension(
  config?: Record<string, unknown>,
  callToolOverride?: (name: string, args: Record<string, unknown>) => unknown,
  connectOverride?: () => Promise<void>,
) {
  if (config) {
    mockConfigContent = JSON.stringify({ 'pi-computer-use': config });
  } else {
    mockConfigContent = null;
  }
  registeredTools.clear();
  for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  mockPi.registerTool.mockClear();
  mockPi.on.mockClear();
  mockNotify.mockClear();
  mockCallToolFn =
    callToolOverride ?? (() => ({ content: [{ type: 'text', text: 'Action executed.' }] }));
  mockClientConnectFn = connectOverride ?? (async () => {});

  computerUseExtension(mockPi as any);

  for (const handler of eventHandlers.session_start ?? []) {
    await handler({}, mockCtx);
  }
}

describe('computerUseExtension', () => {
  beforeEach(() => {
    registeredTools.clear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  });

  test('registers session_start and session_shutdown handlers', () => {
    computerUseExtension(mockPi as any);

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  test('auto-discovers and registers upstream MCP tools with computer_use_ prefix', async () => {
    await initExtension();

    expect(registeredTools.has('computer_use_click')).toBe(true);
    expect(registeredTools.has('computer_use_type_text')).toBe(true);
  });

  test('excludes screenshot from registered tools (use analyze_screenshot instead)', async () => {
    await initExtension();

    expect(registeredTools.has('computer_use_screenshot')).toBe(false);
  });

  test('registered tools have correct descriptions', async () => {
    await initExtension();

    const clickTool = registeredTools.get('computer_use_click')!;
    expect(clickTool.description).toBe('Click at coordinates');
  });

  test('registers analyze_screenshot tool when visionModel is configured', async () => {
    await initExtension({ visionModel: { provider: 'openai', model: 'gpt-4o' } });

    expect(registeredTools.has('computer_use_analyze_screenshot')).toBe(true);
  });

  test('does not register analyze_screenshot without visionModel', async () => {
    await initExtension();

    expect(registeredTools.has('computer_use_analyze_screenshot')).toBe(false);
  });
});

describe('config', () => {
  test('provides sane defaults', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig();
    expect(config.mode).toBe('bundled');
  });

  test('merges user config over defaults', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({ mode: 'path', binaryPath: '/opt/cua-driver' });
    expect(config.mode).toBe('path');
    expect(config.binaryPath).toBe('/opt/cua-driver');
  });

  test('preserves visionModel config', async () => {
    const { resolveConfig } = await import('../config.js');
    const config = resolveConfig({
      visionModel: { provider: 'openai', model: 'gpt-4o' },
    });
    expect(config.visionModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });
});

describe('permissions', () => {
  beforeEach(() => {
    registeredTools.clear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  });

  test('notifies warning when accessibility is not granted on session_start', async () => {
    await initExtension(undefined, (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: '❌ Accessibility: NOT granted.' }],
          structuredContent: { accessibility: false, screen_recording: true },
        };
      }
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Accessibility permission not granted'),
      'warning',
    );
    expect(mockNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('Screen Recording permission not granted'),
      expect.anything(),
    );
  });

  test('notifies warning when screen recording is not granted on session_start', async () => {
    await initExtension(undefined, (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: '❌ Screen Recording: NOT granted.' }],
          structuredContent: { accessibility: true, screen_recording: false },
        };
      }
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Screen Recording permission not granted'),
      'warning',
    );
    expect(mockNotify).not.toHaveBeenCalledWith(
      expect.stringContaining('Accessibility permission not granted'),
      expect.anything(),
    );
  });

  test('notifies both warnings when neither permission is granted', async () => {
    await initExtension(undefined, (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'Not granted.' }],
          structuredContent: { accessibility: false, screen_recording: false },
        };
      }
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Accessibility permission not granted'),
      'warning',
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Screen Recording permission not granted'),
      'warning',
    );
  });

  test('does not notify when all permissions are granted', async () => {
    await initExtension(undefined, (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'All granted.' }],
          structuredContent: { accessibility: true, screen_recording: true },
        };
      }
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    });

    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('does not block session_start if check_permissions throws', async () => {
    await initExtension(undefined, (name: string) => {
      if (name === 'check_permissions') {
        throw new Error('cua-driver crashed');
      }
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    });

    expect(registeredTools.has('computer_use_click')).toBe(true);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('tool returns friendly message on ax_not_granted error', async () => {
    const callToolImpl = (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'All granted.' }],
          structuredContent: { accessibility: true, screen_recording: true },
        };
      }
      return {
        content: [{ type: 'text', text: 'ax_not_granted: permission denied' }],
        isError: true,
      };
    };
    await initExtension(undefined, callToolImpl);

    const clickTool = registeredTools.get('computer_use_click')!;
    const result = (await clickTool.execute(
      'id',
      { x: 100, y: 100 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Accessibility permission not granted');
    expect(result.content[0].text).toContain('System Settings');
  });

  test('tool returns friendly message on sc_not_granted error', async () => {
    const callToolImpl = (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'All granted.' }],
          structuredContent: { accessibility: true, screen_recording: true },
        };
      }
      return {
        content: [{ type: 'text', text: 'sc_not_granted: screen recording denied' }],
        isError: true,
      };
    };
    await initExtension(undefined, callToolImpl);

    const clickTool = registeredTools.get('computer_use_click')!;
    const result = (await clickTool.execute(
      'id',
      { pid: 1 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Screen Recording permission not granted');
    expect(result.content[0].text).toContain('System Settings');
  });

  test('tool passes through non-permission errors unchanged', async () => {
    const callToolImpl = (name: string) => {
      if (name === 'check_permissions') {
        return {
          content: [{ type: 'text', text: 'All granted.' }],
          structuredContent: { accessibility: true, screen_recording: true },
        };
      }
      return {
        content: [{ type: 'text', text: 'element_not_found: ref is stale' }],
        isError: true,
      };
    };
    await initExtension(undefined, callToolImpl);

    const clickTool = registeredTools.get('computer_use_click')!;
    const result = (await clickTool.execute(
      'id',
      { x: 100, y: 100 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('element_not_found: ref is stale');
  });
});

describe('binary permissions', () => {
  beforeEach(() => {
    registeredTools.clear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    mockNotify.mockClear();
  });

  test('auto-fixes binary without execute permission via chmod', async () => {
    const { accessSync, chmodSync } = await import('node:fs');
    const mockAccessSync = vi.mocked(accessSync);
    const mockChmodSync = vi.mocked(chmodSync);

    mockAccessSync.mockImplementation((_path, mode) => {
      if (mode === 1) throw new Error('EACCES');
    });
    mockChmodSync.mockImplementation(() => {});

    await initExtension();

    expect(mockChmodSync).toHaveBeenCalled();
    expect(registeredTools.has('computer_use_click')).toBe(true);

    mockAccessSync.mockReset();
    mockChmodSync.mockReset();
  });

  test('notifies warning when chmod fails (e.g. root-owned binary)', async () => {
    const { accessSync, chmodSync } = await import('node:fs');
    const mockAccessSync = vi.mocked(accessSync);
    const mockChmodSync = vi.mocked(chmodSync);

    mockAccessSync.mockImplementation((_path, mode) => {
      if (mode === 1) throw new Error('EACCES');
    });
    mockChmodSync.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });

    await initExtension();

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('cua-driver failed to start'),
      'warning',
    );

    mockAccessSync.mockReset();
    mockChmodSync.mockReset();
  });

  test('registers fallback tools when binary is not executable', async () => {
    const { accessSync, chmodSync } = await import('node:fs');
    const mockAccessSync = vi.mocked(accessSync);
    const mockChmodSync = vi.mocked(chmodSync);

    mockAccessSync.mockImplementation((_path, mode) => {
      if (mode === 1) throw new Error('EACCES');
    });
    mockChmodSync.mockImplementation(() => {
      throw new Error('EPERM');
    });

    await initExtension();

    expect(mockNotify).toHaveBeenCalled();
    expect(registeredTools.has('computer_use_click')).toBe(true);
    expect(registeredTools.has('computer_use_type_text')).toBe(true);

    mockAccessSync.mockReset();
    mockChmodSync.mockReset();
  });
});

describe('analyze_screenshot', () => {
  beforeEach(() => {
    registeredTools.clear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    mockNotify.mockClear();
  });

  test('passes window_id to underlying screenshot tool', async () => {
    let capturedArgs: Record<string, unknown> = {};
    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      (name: string, args: Record<string, unknown>) => {
        if (name === 'check_permissions') {
          return {
            content: [{ type: 'text', text: 'All granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          };
        }
        if (name === 'screenshot') {
          capturedArgs = args;
          return {
            content: [{ type: 'image', data: 'fakebase64', mimeType: 'image/png' }],
          };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    const tool = registeredTools.get('computer_use_analyze_screenshot')!;
    // execute will fail at vision model call, but we can verify screenshot args were passed
    try {
      await tool.execute('id', { window_id: 12345 }, undefined, undefined, mockCtx);
    } catch {
      // vision model not available in test, that's fine
    }
    expect(capturedArgs.window_id).toBe(12345);
  });

  test('passes format and quality to underlying screenshot tool', async () => {
    let capturedArgs: Record<string, unknown> = {};
    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      (name: string, args: Record<string, unknown>) => {
        if (name === 'check_permissions') {
          return {
            content: [{ type: 'text', text: 'All granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          };
        }
        if (name === 'screenshot') {
          capturedArgs = args;
          return {
            content: [{ type: 'image', data: 'fakebase64', mimeType: 'image/jpeg' }],
          };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    const tool = registeredTools.get('computer_use_analyze_screenshot')!;
    try {
      await tool.execute(
        'id',
        { window_id: 99, format: 'jpeg', quality: 80 },
        undefined,
        undefined,
        mockCtx,
      );
    } catch {
      // vision model not available in test
    }
    expect(capturedArgs).toEqual({ window_id: 99, format: 'jpeg', quality: 80 });
  });

  test('returns error text from cua-driver when screenshot fails', async () => {
    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      (name: string) => {
        if (name === 'check_permissions') {
          return {
            content: [{ type: 'text', text: 'All granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          };
        }
        if (name === 'screenshot') {
          return {
            content: [{ type: 'text', text: 'screencapture failed: window not found' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    const tool = registeredTools.get('computer_use_analyze_screenshot')!;
    const result = (await tool.execute(
      'id',
      { window_id: 999 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Screenshot failed for window 999');
  });

  test('returns sc_not_granted hint when screen recording denied', async () => {
    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      (name: string) => {
        if (name === 'check_permissions') {
          return {
            content: [{ type: 'text', text: 'All granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          };
        }
        if (name === 'screenshot') {
          return {
            content: [{ type: 'text', text: 'sc_not_granted' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    const tool = registeredTools.get('computer_use_analyze_screenshot')!;
    const result = (await tool.execute(
      'id',
      { window_id: 1 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Screen Recording permission not granted');
  });

  test('returns connect error when cua-driver is not running', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      undefined,
      connectFail,
    );

    const tool = registeredTools.get('computer_use_analyze_screenshot')!;
    const result = (await tool.execute(
      'id',
      { window_id: 1 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to connect to cua-driver');
  });
});

describe('connect failure resilience', () => {
  beforeEach(() => {
    registeredTools.clear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    mockNotify.mockClear();
    mockClientConnectFn = async () => {};
  });

  test('registers fallback tools when Client.connect() throws', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(undefined, undefined, connectFail);

    expect(registeredTools.has('computer_use_click')).toBe(true);
    expect(registeredTools.has('computer_use_type_text')).toBe(true);
    expect(registeredTools.has('computer_use_scroll')).toBe(true);
  });

  test('notifies user when connect fails at startup', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(undefined, undefined, connectFail);

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('cua-driver failed to start'),
      'warning',
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('Connection refused'),
      'warning',
    );
  });

  test('tool execute returns friendly error when not connected', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(undefined, undefined, connectFail);

    const clickTool = registeredTools.get('computer_use_click')!;
    const result = (await clickTool.execute(
      'id',
      { x: 100, y: 100 },
      undefined,
      undefined,
      mockCtx,
    )) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to connect to cua-driver');
    expect(result.content[0].text).toContain('System Settings');
  });

  test('tool execute notifies user when not connected', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(undefined, undefined, connectFail);
    mockNotify.mockClear();

    const clickTool = registeredTools.get('computer_use_click')!;
    await clickTool.execute('id', { x: 100, y: 100 }, undefined, undefined, mockCtx);

    expect(mockNotify).toHaveBeenCalledWith(
      expect.stringContaining('cannot connect to cua-driver'),
      'warning',
    );
  });

  test('registers vision tool even when connect fails', async () => {
    const connectFail = async () => {
      throw new Error('Connection refused');
    };

    await initExtension(
      { visionModel: { provider: 'openai', model: 'gpt-4o' } },
      undefined,
      connectFail,
    );

    expect(registeredTools.has('computer_use_analyze_screenshot')).toBe(true);
  });
});
