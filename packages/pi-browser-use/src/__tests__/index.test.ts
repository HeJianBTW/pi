import { beforeEach, describe, expect, test, vi } from 'vitest';

// --- Mocks ---

const mockListAllTools = vi.fn(() =>
  Promise.resolve([
    {
      name: 'click',
      description: 'Click an element.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'take_snapshot',
      description: 'Take snapshot.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'lighthouse_audit',
      description: 'Run audit.',
      inputSchema: { type: 'object' as const },
    },
    {
      name: 'navigate_page',
      description: 'Navigate.',
      inputSchema: { type: 'object' as const },
    },
  ]),
);

const mockCallTool = vi.fn((_name: string, _args: Record<string, unknown>) =>
  Promise.resolve({
    content: [{ type: 'text', text: 'Tool result' }],
  }),
);

const mockConnect = vi.fn(() => Promise.resolve());
const mockClose = vi.fn(() => Promise.resolve());

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    listTools = vi.fn(() => mockListAllTools().then((tools) => ({ tools, nextCursor: undefined })));
    callTool = vi.fn((req: { name: string; arguments: Record<string, unknown> }) =>
      mockCallTool(req.name, req.arguments),
    );
    close = mockClose;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onerror: unknown;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn(() => {
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

const { default: browserUseExtension } = await import('../index.js');

/** Register the extension and fire session_start. */
async function startExtension(config?: Record<string, unknown>) {
  if (config) {
    const fs = await import('node:fs');
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({ 'pi-browser-use': config }),
    );
  }

  browserUseExtension(mockPi as any);

  for (const handler of sessionStartHandlers) {
    await handler();
  }
}

/** Fire all session_shutdown handlers. */
async function shutdownExtension() {
  for (const handler of sessionShutdownHandlers) {
    await handler();
  }
}

// --- Tests ---

describe('browserUseExtension', () => {
  beforeEach(() => {
    registeredTools.clear();
    sessionStartHandlers.length = 0;
    sessionShutdownHandlers.length = 0;
    mockPi.registerTool.mockClear();
    mockPi.on.mockClear();
    mockConnect.mockClear();
    mockCallTool.mockClear();
    mockClose.mockClear();
    mockListAllTools.mockClear();
  });

  test('registers session_start and session_shutdown handlers', () => {
    browserUseExtension(mockPi as any);

    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  describe('config loading', () => {
    test('uses defaults when config.json is missing', async () => {
      await startExtension();
      // Should still register tools — no crash
      expect(registeredTools.size).toBeGreaterThan(0);
    });

    test('reads pi-browser-use section from config.json', async () => {
      await startExtension({ headless: true });
      expect(registeredTools.size).toBeGreaterThan(0);
    });
  });

  describe('tool registration (session_start)', () => {
    test('connects to chrome-devtools-mcp subprocess', async () => {
      await startExtension();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    test('prefixes all tools with browser_', async () => {
      await startExtension();

      for (const name of registeredTools.keys()) {
        expect(name.startsWith('browser_')).toBe(true);
      }
    });

    test('registers expected upstream tools', async () => {
      await startExtension();

      const names = [...registeredTools.keys()];
      expect(names).toContain('browser_click');
      expect(names).toContain('browser_take_snapshot');
      expect(names).toContain('browser_navigate_page');
    });

    test('excludes lighthouse_audit', async () => {
      await startExtension();

      const names = [...registeredTools.keys()];
      expect(names).not.toContain('browser_lighthouse_audit');
    });

    test('augments tool descriptions with usage hints', async () => {
      await startExtension();

      const clickTool = registeredTools.get('browser_click');
      expect(clickTool!.description).toContain('uid');

      const snapshotTool = registeredTools.get('browser_take_snapshot');
      expect(snapshotTool!.description).toContain('Call this FIRST');
    });

    test('registers analyze_screenshot when visionModel is configured', async () => {
      await startExtension({
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      });

      expect(registeredTools.has('browser_analyze_screenshot')).toBe(true);
    });

    test('does not register analyze_screenshot without visionModel', async () => {
      await startExtension();

      expect(registeredTools.has('browser_analyze_screenshot')).toBe(false);
    });
  });

  describe('tool execution (callTool)', () => {
    test('routes browser_click to upstream click', async () => {
      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      await clickTool.execute('call-1', { uid: '1_2' }, undefined, undefined, {});

      expect(mockCallTool).toHaveBeenCalledWith('click', { uid: '1_2' });
    });

    test('returns upstream text content', async () => {
      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toBe('Tool result');
    });

    test('strips embedded page snapshot from non-snapshot results', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Clicked\n## Latest page snapshot\n<tree>data</tree>',
          },
        ],
      });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0]!.text).toContain('Clicked');
      expect(result.content[0]!.text).not.toContain('Latest page snapshot');
    });

    test('returns fallback empty text when upstream returns no content', async () => {
      mockCallTool.mockResolvedValueOnce({ content: [] });

      await startExtension();
      const clickTool = registeredTools.get('browser_click')!;

      const result = (await clickTool.execute('call-1', {}, undefined, undefined, {})) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.text).toBe('');
    });
  });

  describe('lifecycle (session_shutdown)', () => {
    test('closes the chrome-devtools-mcp subprocess', async () => {
      await startExtension();
      await shutdownExtension();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    test('no-ops when shutdown called without prior start', async () => {
      browserUseExtension(mockPi as any);

      // Fire shutdown without ever calling session_start
      await shutdownExtension();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });
});
