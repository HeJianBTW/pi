import { describe, expect, it, vi } from 'vitest';
import mem0Extension from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPi() {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const tools: Array<{ name: string }> = [];

  return {
    pi: {
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      registerTool: (tool: { name: string }) => tools.push(tool),
      registerCommand: (
        name: string,
        opts: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        commands[name] = opts;
      },
    },
    handlers,
    commands,
    tools,
  };
}

function createMockCtx() {
  return {
    cwd: '/tmp',
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: {
      getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

describe('mem0Extension registration', () => {
  it('registers session_start, turn_end, before_agent_start, session_shutdown', () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    expect(handlers.session_start).toHaveLength(1);
    expect(handlers.turn_end).toHaveLength(1);
    expect(handlers.before_agent_start).toHaveLength(1);
    expect(handlers.session_shutdown).toHaveLength(1);
  });

  it('registers /mem0 command', () => {
    const { pi, commands } = createMockPi();
    mem0Extension(pi as never);
    expect(commands.mem0).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// session_start — disabled state
// ---------------------------------------------------------------------------

describe('session_start — no config', () => {
  it('sets disabled status when no API key in platform mode', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('mem0', expect.stringContaining('disabled'));
  });

  it('does not register tools when disabled', async () => {
    const { pi, handlers, tools } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    expect(tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// turn_end — no-op when not initialized
// ---------------------------------------------------------------------------

describe('turn_end — not initialized', () => {
  it('does not throw when extension is disabled', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    // Should not throw
    await handlers.turn_end![0]!(
      { turnIndex: 0, message: { role: 'user', content: 'hello' }, toolResults: [] },
      ctx,
    );
  });
});

// ---------------------------------------------------------------------------
// before_agent_start — no-op when not initialized
// ---------------------------------------------------------------------------

describe('before_agent_start — not initialized', () => {
  it('returns undefined when extension is disabled', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    const result = await handlers.before_agent_start![0]!({ systemPrompt: 'existing' }, ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /mem0 command — when not active
// ---------------------------------------------------------------------------

describe('/mem0 command — not active', () => {
  it('shows warning when not configured', async () => {
    const { pi, commands } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await commands.mem0!.handler('status', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Mem0 is not active.', 'warning');
  });

  it('shows warning for search', async () => {
    const { pi, commands } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await commands.mem0!.handler('search test', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Mem0 is not active.', 'warning');
  });

  it('shows warning for profile', async () => {
    const { pi, commands } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await commands.mem0!.handler('profile', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Mem0 is not active.', 'warning');
  });

  it('shows warning for unknown subcommand', async () => {
    const { pi, commands } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await commands.mem0!.handler('foobar', ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith('Mem0 is not active.', 'warning');
  });
});

// ---------------------------------------------------------------------------
// session_shutdown — cleanup
// ---------------------------------------------------------------------------

describe('session_shutdown', () => {
  it('does not throw', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);
    await handlers.session_shutdown![0]!({}, ctx);
  });

  it('resets state so before_agent_start returns undefined after shutdown', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);
    await handlers.session_shutdown![0]!({}, ctx);

    const result = await handlers.before_agent_start![0]!({ systemPrompt: 'test' }, ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractText helper (tested indirectly via turn_end)
// ---------------------------------------------------------------------------

describe('turn_end — message extraction', () => {
  it('handles string content messages', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    // Should not throw even though provider is not initialized
    await handlers.turn_end![0]!(
      { turnIndex: 0, message: { role: 'user', content: 'hello world' }, toolResults: [] },
      ctx,
    );
  });

  it('handles content block array messages', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    await handlers.turn_end![0]!(
      {
        turnIndex: 0,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'part 1' },
            { type: 'image', data: 'base64' },
          ],
        },
        toolResults: [],
      },
      ctx,
    );
  });

  it('handles empty content gracefully', async () => {
    const { pi, handlers } = createMockPi();
    mem0Extension(pi as never);

    const ctx = createMockCtx();
    await handlers.session_start![0]!({}, ctx);

    await handlers.turn_end![0]!(
      { turnIndex: 0, message: { role: 'user', content: '' }, toolResults: [] },
      ctx,
    );
  });
});
