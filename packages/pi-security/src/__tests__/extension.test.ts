import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import piSecurityExtension, { resolvePiSecurityConfig } from '../extension.js';

describe('pi security extension', () => {
  it('resolves conservative extension defaults', () => {
    expect(resolvePiSecurityConfig()).toEqual({
      enabled: true,
      profile: 'auto-review',
      auditLimit: 200,
      allowSessionGrants: true,
    });
  });

  it('blocks denied approvals before a Pi tool executes', async () => {
    const { handlers } = registerExtension();
    const ctx = createContext({ select: vi.fn(async () => 'Deny') });

    const result = (await handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)) as
      | ToolCallEventResult
      | undefined;

    expect(result).toEqual({
      block: true,
      reason: 'User denied approval: Workspace file modifications require approval.',
    });
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it('supports in-session approval grants for similar tool calls', async () => {
    const { handlers } = registerExtension();
    const select = vi.fn(async () => 'Allow similar for this session');
    const ctx = createContext({ select });

    await expect(handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)).resolves.toBeUndefined();
    await expect(handlers.tool_call?.[0]?.(writeEvent('tool-2'), ctx)).resolves.toBeUndefined();

    expect(select).toHaveBeenCalledOnce();
  });

  it('fails closed for non-interactive approvals', async () => {
    const { handlers } = registerExtension();
    const ctx = createContext({ hasUI: false });

    const result = (await handlers.tool_call?.[0]?.(writeEvent('tool-1'), ctx)) as
      | ToolCallEventResult
      | undefined;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('non-interactive');
  });

  it('registers user-facing commands but no LLM-callable tools', () => {
    const { pi } = registerExtension();

    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-status', expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-audit', expect.any(Object));
    expect(pi.registerCommand).toHaveBeenCalledWith('pi-security-reset', expect.any(Object));
  });
});

function registerExtension(): {
  pi: ExtensionAPI & {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
  };
  handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
} {
  const handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
  const pi = {
    on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers[event] ??= [];
      handlers[event]?.push(handler);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as ExtensionAPI & {
    registerTool: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
  };

  piSecurityExtension(pi);
  return { pi, handlers };
}

function createContext(
  options: {
    hasUI?: boolean;
    select?: ReturnType<typeof vi.fn>;
    confirm?: ReturnType<typeof vi.fn>;
  } = {},
): ExtensionContext {
  return {
    cwd: '/repo',
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getSessionId: () => 'session-1',
    },
    model: {
      provider: 'test',
      id: 'test-model',
    },
    ui: {
      select: options.select ?? vi.fn(async () => 'Allow once'),
      confirm: options.confirm ?? vi.fn(async () => true),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function writeEvent(toolCallId: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId,
    toolName: 'write',
    input: { path: 'approval.txt', content: 'hello' },
  } as ToolCallEvent;
}
