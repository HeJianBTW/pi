import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect() {}
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
    async callTool() {
      return { content: [{ type: 'text', text: 'Action executed.' }] };
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    onerror: ((error: Error) => void) | null = null;
    constructor() {}
  },
}));

let mockConfigContent: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
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

const mockCtx = { cwd: '/tmp', modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() } };

const { default: computerUseExtension } = await import('../index.js');

async function initExtension(config?: Record<string, unknown>) {
  if (config) {
    mockConfigContent = JSON.stringify({ 'pi-computer-use': config });
  } else {
    mockConfigContent = null;
  }
  registeredTools.clear();
  Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
  mockPi.registerTool.mockClear();
  mockPi.on.mockClear();

  computerUseExtension(mockPi as any);

  for (const handler of eventHandlers['session_start'] ?? []) {
    await handler({}, mockCtx);
  }
}

describe('computerUseExtension', () => {
  beforeEach(() => {
    registeredTools.clear();
    Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
  });

  test('registers session_start and session_shutdown handlers', () => {
    computerUseExtension(mockPi as any);

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  test('auto-discovers and registers upstream MCP tools with cua_ prefix', async () => {
    await initExtension();

    expect(registeredTools.has('cua_screenshot')).toBe(true);
    expect(registeredTools.has('cua_click')).toBe(true);
    expect(registeredTools.has('cua_type_text')).toBe(true);
  });

  test('registered tools have correct descriptions', async () => {
    await initExtension();

    const clickTool = registeredTools.get('cua_click')!;
    expect(clickTool.description).toBe('Click at coordinates');
  });

  test('registers analyze_screenshot tool when visionModel is configured', async () => {
    await initExtension({ visionModel: { provider: 'openai', model: 'gpt-4o' } });

    expect(registeredTools.has('cua_analyze_screenshot')).toBe(true);
  });

  test('does not register analyze_screenshot without visionModel', async () => {
    await initExtension();

    expect(registeredTools.has('cua_analyze_screenshot')).toBe(false);
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
