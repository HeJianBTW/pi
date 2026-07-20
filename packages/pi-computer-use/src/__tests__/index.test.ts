import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import toolManifest from '../generated/cua-driver-tools.js';

Object.defineProperty(process, 'platform', { value: 'darwin' });

type UpstreamResult = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type LiveTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

let mockConfigContent: string | null = null;
let mockConnect: () => Promise<void> = async () => {};
let mockCallTool: (name: string, args: Record<string, unknown>) => UpstreamResult = () => ({
  content: [{ type: 'text', text: 'Action executed.' }],
});
let mockLiveTools: readonly LiveTool[] = toolManifest.tools;
let lastRequestOptions: Record<string, unknown> | undefined;
let lastTransport: { onclose?: () => void; onerror?: (error: Error) => void } | undefined;
let closeCount = 0;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect() {
      return mockConnect();
    }
    async close() {
      closeCount++;
    }
    async listTools() {
      return { tools: mockLiveTools, nextCursor: undefined };
    }
    async callTool(
      request: { name: string; arguments?: Record<string, unknown> },
      _schema: unknown,
      options: Record<string, unknown> | undefined,
    ) {
      lastRequestOptions = options;
      return mockCallTool(request.name, request.arguments ?? {});
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class MockTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    constructor() {
      lastTransport = this;
    }
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  }),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, { stdout: '', stderr: '' });
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(() => {
      if (mockConfigContent !== null) return mockConfigContent;
      throw new Error('ENOENT');
    }),
  };
});

vi.mock('../vision.js', () => ({
  createPiVisionCaller: () => async () => 'vision analysis',
}));

interface RegisteredTool {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: typeof mockCtx,
  ) => Promise<unknown>;
}

interface RegisteredCommand {
  handler: (args: unknown, ctx: typeof mockCtx) => Promise<void>;
}

const tools = new Map<string, RegisteredTool>();
const commands = new Map<string, RegisteredCommand>();
const handlers: Record<string, Array<(event: unknown, ctx: typeof mockCtx) => Promise<void>>> = {};
const notify = vi.fn();
const mockCtx = {
  cwd: '/tmp',
  signal: undefined as AbortSignal | undefined,
  hasUI: true,
  ui: { notify, confirm: vi.fn().mockResolvedValue(true) },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
};
const mockPi = {
  registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
  registerCommand: vi.fn((name: string, command: RegisteredCommand) => commands.set(name, command)),
  on: vi.fn((event: string, handler: (event: unknown, ctx: typeof mockCtx) => Promise<void>) => {
    handlers[event] ??= [];
    handlers[event].push(handler);
  }),
};

const { default: computerUseExtension } = await import('../index.js');

async function start(config?: Record<string, unknown>) {
  mockConfigContent = config ? JSON.stringify({ 'pi-computer-use': config }) : null;
  tools.clear();
  commands.clear();
  for (const key of Object.keys(handlers)) delete handlers[key];
  computerUseExtension(mockPi as never);
  for (const handler of handlers.session_start ?? []) await handler({}, mockCtx);
}

describe('computerUseExtension', () => {
  beforeEach(() => {
    mockConnect = async () => {};
    mockCallTool = (name) =>
      name === 'check_permissions'
        ? {
            content: [{ type: 'text', text: 'Permissions granted.' }],
            structuredContent: { accessibility: true, screen_recording: true },
          }
        : { content: [{ type: 'text', text: 'Action executed.' }] };
    mockLiveTools = toolManifest.tools;
    lastRequestOptions = undefined;
    lastTransport = undefined;
    closeCount = 0;
    notify.mockClear();
    mockCtx.ui.confirm.mockClear();
  });

  it('registers the complete live Rust 0.9 tool manifest', async () => {
    await start();

    expect(tools.size).toBe(toolManifest.tools.length);
    expect(tools.has('computer_use_start_session')).toBe(true);
    expect(tools.has('computer_use_health_report')).toBe(true);
    expect(tools.has('computer_use_get_accessibility_tree')).toBe(true);
    expect(tools.has('computer_use_screenshot')).toBe(false);
  });

  it('registers the live platform schema without adding macOS reference tools', async () => {
    mockLiveTools = [
      {
        name: 'platform_specific_tool',
        description: 'Live platform contract',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await start();

    expect(tools.has('computer_use_platform_specific_tool')).toBe(true);
    expect(tools.has('computer_use_click')).toBe(false);
  });

  it('connects and performs a non-prompting permission probe on session start', async () => {
    let connects = 0;
    let permissionArgs: Record<string, unknown> | undefined;
    mockConnect = async () => {
      connects++;
    };
    mockCallTool = (name, args) => {
      if (name === 'check_permissions') permissionArgs = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    };

    await start();

    expect(connects).toBe(1);
    expect(permissionArgs).toEqual({ prompt: false });
  });

  it('registers only a recovery contract after failed platform discovery', async () => {
    let attempts = 0;
    mockConnect = async () => {
      attempts++;
      if (attempts === 1) throw new Error('connection refused');
    };
    mockLiveTools = [
      {
        name: 'platform_specific_tool',
        description: 'Live platform contract',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    await start();

    expect(tools.has('computer_use_click')).toBe(false);
    expect(tools.has('computer_use_connect')).toBe(true);
    expect(commands.has('computer-use-connect')).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      'pi-computer-use: driver unavailable; use computer_use_connect to retry discovery.',
      'warning',
    );

    const result = (await tools
      .get('computer_use_connect')!
      .execute('retry', {}, undefined, undefined, mockCtx)) as any;
    expect(result.content[0].text).toContain('1 platform tools');
    expect(tools.has('computer_use_platform_specific_tool')).toBe(true);
  });

  it('forwards image content, structured output, and cancellation', async () => {
    await start();
    mockCallTool = () => ({
      content: [
        { type: 'image', data: 'image-base64', mimeType: 'image/png' },
        { type: 'text', text: 'window state' },
      ],
      structuredContent: { snapshot_id: 'snapshot-1', elements: [{ element_token: 'token-1' }] },
    });
    const controller = new AbortController();

    const result = (await tools
      .get('computer_use_get_window_state')!
      .execute('id', { pid: 1, window_id: 2 }, controller.signal, undefined, mockCtx)) as any;

    expect(result.content).toEqual([
      { type: 'image', data: 'image-base64', mimeType: 'image/png' },
      { type: 'text', text: 'window state' },
    ]);
    expect(result.details.snapshot_id).toBe('snapshot-1');
    expect(lastRequestOptions?.signal).toBe(controller.signal);
  });

  it('reconnects after the MCP transport closes', async () => {
    let connects = 0;
    mockConnect = async () => {
      connects++;
    };
    await start();
    lastTransport?.onclose?.();

    await tools
      .get('computer_use_click')!
      .execute('id', { pid: 1, x: 2, y: 3 }, undefined, undefined, mockCtx);

    expect(connects).toBe(2);
  });

  it('preserves AbortSignal cancellation instead of rewriting it as a connection error', async () => {
    await start();
    const controller = new AbortController();
    controller.abort(new Error('cancelled by user'));
    mockCallTool = () => {
      throw new Error('transport aborted');
    };

    await expect(
      tools
        .get('computer_use_click')!
        .execute('id', { pid: 1, x: 2, y: 3 }, controller.signal, undefined, mockCtx),
    ).rejects.toThrow('cancelled by user');
  });

  it('returns platform guidance for permission errors', async () => {
    await start();
    mockCallTool = () => ({
      content: [{ type: 'text', text: 'ax_not_granted: permission denied' }],
      isError: true,
    });

    const result = (await tools
      .get('computer_use_click')!
      .execute('id', { pid: 1 }, undefined, undefined, mockCtx)) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Accessibility permission not granted');
  });

  it('confirms each app target once before launching it', async () => {
    await start();

    const launch = tools.get('computer_use_launch_app')!;
    await launch.execute(
      'first',
      { bundle_id: 'com.apple.TextEdit' },
      undefined,
      undefined,
      mockCtx,
    );
    await launch.execute(
      'second',
      { bundle_id: 'com.apple.TextEdit' },
      undefined,
      undefined,
      mockCtx,
    );

    expect(mockCtx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      'Allow computer use?',
      expect.stringContaining('com.apple.TextEdit'),
    );
  });

  it('does not invoke a high-risk tool when confirmation is declined', async () => {
    let invoked = false;
    mockCtx.ui.confirm.mockResolvedValueOnce(false);
    await start();
    mockCallTool = () => {
      invoked = true;
      return { content: [{ type: 'text', text: 'killed' }] };
    };

    const result = (await tools
      .get('computer_use_kill_app')!
      .execute('id', { pid: 42 }, undefined, undefined, mockCtx)) as any;

    expect(invoked).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires interactive user confirmation');
  });

  it('uses get_window_state for optional vision analysis', async () => {
    let call: { name: string; args: Record<string, unknown> } | undefined;
    await start({ visionModel: { provider: 'openai', model: 'gpt-4o' } });
    mockCallTool = (name, args) => {
      call = { name, args };
      return { content: [{ type: 'image', data: 'image-base64', mimeType: 'image/png' }] };
    };

    const result = (await tools
      .get('computer_use_analyze_screenshot')!
      .execute('id', { pid: 12, window_id: 34 }, undefined, undefined, mockCtx)) as any;

    expect(call).toEqual({
      name: 'get_window_state',
      args: { pid: 12, window_id: 34, include_screenshot: true, max_elements: 1 },
    });
    expect(result.content[0].text).toBe('vision analysis');
  });

  it('closes the MCP client on session shutdown', async () => {
    await start();
    for (const handler of handlers.session_shutdown ?? []) await handler({}, mockCtx);
    expect(closeCount).toBeGreaterThan(0);
  });
});

describe('config', () => {
  it('defaults to the bundled driver', async () => {
    const { resolveConfig } = await import('../config.js');
    expect(resolveConfig().mode).toBe('bundled');
  });

  it('preserves a custom path and vision model', async () => {
    const { resolveConfig } = await import('../config.js');
    expect(
      resolveConfig({
        mode: 'path',
        binaryPath: '/opt/cua-driver',
        visionModel: { provider: 'openai', model: 'gpt-4o' },
      }),
    ).toMatchObject({
      mode: 'path',
      binaryPath: '/opt/cua-driver',
      visionModel: { provider: 'openai', model: 'gpt-4o' },
    });
  });
});
