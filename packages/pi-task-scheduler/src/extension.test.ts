import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskScheduler,
  type TaskSchedulerScope,
} from './index.js';

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

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function createMockPi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};

  return {
    tools,
    commands,
    eventHandlers,
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, cmd: RegisteredCommand) => {
      commands.set(name, cmd);
    }),
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    sendUserMessage: vi.fn(),
  };
}

function createMockCtx(cwd = '/tmp') {
  return {
    cwd,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: { getSessionId: () => 'test-session-1' },
    model: { id: 'test-model' },
  };
}

class MemStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();

  async list(_scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return Array.from(this.tasks.values());
  }
  async get(taskId: string): Promise<ScheduledTask | undefined> {
    return this.tasks.get(taskId);
  }
  async create(task: ScheduledTask): Promise<ScheduledTask> {
    this.tasks.set(task.id, task);
    return task;
  }
  async update(taskId: string, task: ScheduledTask): Promise<ScheduledTask | undefined> {
    if (!this.tasks.has(taskId)) return undefined;
    this.tasks.set(taskId, task);
    return task;
  }
  async delete(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }
}

class MemLock implements SchedulerLock {
  readonly path = 'memory:test';
  private locked = false;
  acquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  release(): void {
    this.locked = false;
  }
  isAcquired(): boolean {
    return this.locked;
  }
  holderPid(): number | undefined {
    return this.locked ? process.pid : undefined;
  }
}

async function setupExtension(injectedConfig?: Record<string, unknown>) {
  const { default: taskSchedulerExtension } = await import('./extension.js');
  const pi = createMockPi();
  const ctx = createMockCtx();

  taskSchedulerExtension(pi as any, injectedConfig as any);

  for (const handler of pi.eventHandlers.session_start ?? []) {
    await handler({}, ctx);
  }

  return { pi, ctx };
}

describe('extension — default file storage mode', () => {
  it('registers all tools and commands on session_start', async () => {
    const { pi } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    expect(pi.tools.has('scheduler_create')).toBe(true);
    expect(pi.tools.has('scheduler_list')).toBe(true);
    expect(pi.tools.has('scheduler_get')).toBe(true);
    expect(pi.tools.has('scheduler_update')).toBe(true);
    expect(pi.tools.has('scheduler_delete')).toBe(true);
    expect(pi.tools.has('scheduler_run_now')).toBe(true);

    expect(pi.commands.has('pi-scheduler-status')).toBe(true);
    expect(pi.commands.has('pi-scheduler-list')).toBe(true);
    expect(pi.commands.has('pi-scheduler-run-now')).toBe(true);
  });

  it('sets status to active when scheduler starts', async () => {
    const { ctx } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-scheduler', 'scheduler: active');
  });

  it('scheduler_list returns empty when no tasks', async () => {
    const { pi } = await setupExtension({ dataDir: '/tmp/pi-test-ext' });

    const tool = pi.tools.get('scheduler_list')!;
    const result = (await tool.execute('id', {}, undefined, undefined, createMockCtx())) as any;

    expect(result.content[0].text).toBe('No scheduled tasks.');
  });
});

describe('extension — injected scheduler', () => {
  let externalScheduler: TaskScheduler;
  let store: MemStore;

  beforeEach(async () => {
    store = new MemStore();
    externalScheduler = new PersistentTaskScheduler({
      store,
      lock: new MemLock(),
      runner: async () => {},
    });
    await externalScheduler.start();
  });

  it('uses injected scheduler without creating its own', async () => {
    const { pi, ctx } = await setupExtension({ scheduler: externalScheduler });

    expect(ctx.ui.setStatus).toHaveBeenCalledWith('pi-scheduler', 'scheduler: active');

    const tool = pi.tools.get('scheduler_create')!;
    const result = (await tool.execute(
      'id',
      { type: 'interval', schedule: '10m', prompt: 'injected test' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.prompt).toBe('injected test');
    expect(store.tasks.size).toBe(1);
  });

  it('does not stop injected scheduler on session_shutdown', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });

    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, createMockCtx());
    }

    expect(externalScheduler.isActive()).toBe(true);
  });

  it('stops self-created scheduler on session_shutdown', async () => {
    const { pi } = await setupExtension({
      store: new MemStore(),
      lock: new MemLock(),
    });

    for (const handler of pi.eventHandlers.session_shutdown ?? []) {
      await handler({}, createMockCtx());
    }

    // Tools should return "not running" after shutdown
    const tool = pi.tools.get('scheduler_list')!;
    const result = (await tool.execute('id', {}, undefined, undefined, createMockCtx())) as any;
    expect(result.content[0].text).toBe('Task scheduler is not running.');
  });
});

describe('extension — tool operations with injected scheduler', () => {
  let externalScheduler: TaskScheduler;
  let store: MemStore;

  beforeEach(async () => {
    store = new MemStore();
    externalScheduler = new PersistentTaskScheduler({
      store,
      lock: new MemLock(),
      runner: async () => {},
    });
    await externalScheduler.start();
  });

  it('scheduler_create creates a task via injected scheduler', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_create')!;
    const ctx = createMockCtx();

    const result = (await tool.execute(
      'id',
      {
        type: 'cron',
        schedule: '0 9 * * 1-5',
        prompt: 'daily standup reminder',
        name: 'standup',
      },
      undefined,
      undefined,
      ctx,
    )) as any;

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('standup');
    expect(parsed.type).toBe('cron');
    expect(parsed.schedule).toBe('0 9 * * 1-5');
    expect(store.tasks.size).toBe(1);
  });

  it('scheduler_get returns task details', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const getTool = pi.tools.get('scheduler_get')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '5m', prompt: 'check health' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const getResult = (await getTool.execute('id', { taskId }, undefined, undefined, ctx)) as any;
    const task = JSON.parse(getResult.content[0].text);
    expect(task.id).toBe(taskId);
    expect(task.prompt).toBe('check health');
  });

  it('scheduler_get returns not found for missing task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_get')!;

    const result = (await tool.execute(
      'id',
      { taskId: 'nonexistent' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;

    expect(result.content[0].text).toBe('Task not found: nonexistent');
  });

  it('scheduler_update modifies task fields', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const updateTool = pi.tools.get('scheduler_update')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '10m', prompt: 'original' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const updateResult = (await updateTool.execute(
      'id',
      { taskId, prompt: 'updated', enabled: false },
      undefined,
      undefined,
      ctx,
    )) as any;
    const updated = JSON.parse(updateResult.content[0].text);
    expect(updated.prompt).toBe('updated');
    expect(updated.enabled).toBe(false);
  });

  it('scheduler_delete removes a task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const deleteTool = pi.tools.get('scheduler_delete')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '1h', prompt: 'temp' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const deleteResult = (await deleteTool.execute(
      'id',
      { taskId },
      undefined,
      undefined,
      ctx,
    )) as any;
    expect(deleteResult.content[0].text).toBe(`Deleted task: ${taskId}`);
    expect(store.tasks.size).toBe(0);
  });

  it('scheduler_delete returns not found for missing task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const tool = pi.tools.get('scheduler_delete')!;

    const result = (await tool.execute(
      'id',
      { taskId: 'ghost' },
      undefined,
      undefined,
      createMockCtx(),
    )) as any;
    expect(result.content[0].text).toBe('Task not found: ghost');
  });

  it('scheduler_run_now triggers a task', async () => {
    const { pi } = await setupExtension({ scheduler: externalScheduler });
    const createTool = pi.tools.get('scheduler_create')!;
    const runTool = pi.tools.get('scheduler_run_now')!;
    const ctx = createMockCtx();

    const createResult = (await createTool.execute(
      'id',
      { type: 'interval', schedule: '1h', prompt: 'run me', name: 'runner' },
      undefined,
      undefined,
      ctx,
    )) as any;
    const taskId = JSON.parse(createResult.content[0].text).id;

    const runResult = (await runTool.execute('id', { taskId }, undefined, undefined, ctx)) as any;
    expect(runResult.content[0].text).toBe('Triggered: runner');
  });

  it('all tools return not running when scheduler is undefined', async () => {
    const { default: taskSchedulerExtension } = await import('./extension.js');
    const pi = createMockPi();
    taskSchedulerExtension(pi as any);
    // Don't fire session_start — scheduler stays undefined

    const ctx = createMockCtx();
    for (const tool of Array.from(pi.tools.values())) {
      const result = (await tool.execute('id', {}, undefined, undefined, ctx)) as any;
      expect(result.content[0].text).toContain('not running');
    }
  });
});
