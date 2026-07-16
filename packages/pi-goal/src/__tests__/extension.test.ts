import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock derive so `/goal` (no-arg) derivation is deterministic.
const deriveCondition = vi.fn();
vi.mock('../derive.js', () => ({
  deriveCondition: (...args: unknown[]) => deriveCondition(...args),
}));
// Mock evaluate so agent_end doesn't hit a live model.
const evaluateCondition = vi.fn();
vi.mock('../evaluate.js', () => ({
  evaluateCondition: (...args: unknown[]) => evaluateCondition(...args),
}));
// Mock buildSessionContext so the interactive /goal path reads controllable
// conversation history from the (mocked) session manager.
const sessionMessages = vi.fn(() => [] as unknown[]);
vi.mock('@earendil-works/pi-coding-agent', () => ({
  buildSessionContext: () => ({ messages: sessionMessages() }),
}));

import goalExtension from '../extension.js';

type Handler = (event: unknown, ctx: unknown) => Promise<void>;
type CommandOpts = {
  description: string;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string }>;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function createMockPi(flagValue?: string) {
  const commands = new Map<string, CommandOpts>();
  const eventHandlers: Record<string, Handler[]> = {};
  const sendUserMessage = vi.fn();
  const flags = new Map<string, boolean | string>();
  return {
    commands,
    eventHandlers,
    sendUserMessage,
    flags,
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, opts: CommandOpts) => commands.set(name, opts)),
    registerFlag: vi.fn((name: string) => {
      if (flagValue !== undefined) flags.set(name, flagValue);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    on: vi.fn((event: string, handler: Handler) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    appendEntry: vi.fn(),
  };
}

function createMockCtx(hasUI = true) {
  return {
    cwd: '/tmp/pi-goal-test',
    hasUI,
    signal: undefined,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
    },
    modelRegistry: {
      find: () => ({}),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
    },
  };
}

// Inject a model so the engine is enabled without depending on settings files.
const injected = { model: { provider: 'p', model: 'm' } };

describe('goalExtension wiring', () => {
  beforeEach(() => {
    deriveCondition.mockReset();
    evaluateCondition.mockReset();
    sessionMessages.mockReset();
    sessionMessages.mockReturnValue([]);
  });

  it('registers the /goal command and lifecycle handlers', () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    expect(pi.commands.has('goal')).toBe(true);
    expect(pi.registerFlag).toHaveBeenCalledWith(
      'goal',
      expect.objectContaining({ type: 'string' }),
    );
    expect(pi.eventHandlers.session_start).toBeDefined();
    expect(pi.eventHandlers.before_agent_start).toBeDefined();
    expect(pi.eventHandlers.agent_end).toBeDefined();
    expect(pi.eventHandlers.session_shutdown).toBeDefined();
  });

  it('sets and activates a goal from the --goal flag at session start', async () => {
    const pi = createMockPi('all tests pass');
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0]?.[0]).toContain('all tests pass');
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-goal', expect.stringContaining('active'));
  });

  it('does not set a goal when the --goal flag is absent', async () => {
    const pi = createMockPi(); // no flag value
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('defers empty --goal derivation to before_agent_start, using the prompt', async () => {
    const pi = createMockPi(''); // bare --goal (empty value)
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();

    // session_start must NOT derive yet — no transcript exists.
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    expect(deriveCondition).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // First before_agent_start carries the prompt → derive and set the goal.
    deriveCondition.mockResolvedValue('The login endpoint returns 200 for valid credentials');
    await pi.eventHandlers.before_agent_start![0]!(
      { type: 'before_agent_start', prompt: 'make the login endpoint work' },
      ctx,
    );
    expect(deriveCondition).toHaveBeenCalledTimes(1);
    // The current turn's prompt must be part of the derivation transcript.
    expect(deriveCondition.mock.calls[0]?.[0]?.transcript).toContain(
      'make the login endpoint work',
    );
    // Goal is active…
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-goal', expect.stringContaining('active'));
    // …but no activation message is injected here — the agent is about to run
    // this prompt; injecting would throw "already processing".
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('only derives once even across multiple before_agent_start events', async () => {
    const pi = createMockPi('');
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    deriveCondition.mockResolvedValue('some derived condition');
    await pi.eventHandlers.before_agent_start![0]!(
      { type: 'before_agent_start', prompt: 'first' },
      ctx,
    );
    await pi.eventHandlers.before_agent_start![0]!(
      { type: 'before_agent_start', prompt: 'second' },
      ctx,
    );
    expect(deriveCondition).toHaveBeenCalledTimes(1);
  });

  it('sets an explicit goal and injects an activation message', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);

    await pi.commands.get('goal')!.handler('all tests pass', ctx);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0]?.[0]).toContain('all tests pass');
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-goal', expect.stringContaining('active'));
  });

  it('clears a goal via keyword', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);

    await pi.commands.get('goal')!.handler('build succeeds', ctx);
    pi.sendUserMessage.mockClear();
    await pi.commands.get('goal')!.handler('clear', ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/cleared/i), 'info');
  });

  it('derives a goal on no-arg /goal and confirms in TUI', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx(true);
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);

    // Session history (read via the mocked buildSessionContext) gives derive
    // something to work with.
    sessionMessages.mockReturnValue([{ role: 'user', content: 'make login work' }]);
    deriveCondition.mockResolvedValue('The login flow authenticates valid users');

    await pi.commands.get('goal')!.handler('', ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining('The login flow authenticates valid users'),
    );
  });

  it('does not set a derived goal when the user declines confirmation', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx(true);
    ctx.ui.confirm = vi.fn(async () => false);
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    sessionMessages.mockReturnValue([{ role: 'user', content: 'x' }]);
    deriveCondition.mockResolvedValue('some condition');

    await pi.commands.get('goal')!.handler('', ctx);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('agent_end evaluates and continues an active goal', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    await pi.commands.get('goal')!.handler('all tests pass', ctx);
    pi.sendUserMessage.mockClear();

    evaluateCondition.mockResolvedValue({ ok: false, impossible: false, reason: 'still failing' });
    await pi.eventHandlers.agent_end![0]!(
      { type: 'agent_end', messages: [{ role: 'assistant', content: 'ran tests' }] },
      ctx,
    );
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('still failing'));
  });

  it('agent_end is a no-op after the goal is cleared', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    await pi.commands.get('goal')!.handler('all tests pass', ctx);
    await pi.commands.get('goal')!.handler('clear', ctx);
    pi.sendUserMessage.mockClear();
    evaluateCondition.mockResolvedValue({ ok: false, impossible: false, reason: 'x' });

    await pi.eventHandlers.agent_end![0]!(
      { type: 'agent_end', messages: [{ role: 'assistant', content: 'y' }] },
      ctx,
    );
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('shows status on no-arg /goal when a goal is already active', async () => {
    const pi = createMockPi();
    goalExtension(pi as never, injected);
    const ctx = createMockCtx();
    await pi.eventHandlers.session_start![0]!({ type: 'session_start' }, ctx);
    await pi.commands.get('goal')!.handler('build succeeds', ctx);

    await pi.commands.get('goal')!.handler('', ctx);
    expect(deriveCondition).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('build succeeds'),
      'info',
    );
  });
});
