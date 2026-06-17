import { describe, expect, it } from 'vitest';
import {
  PersistentTaskScheduler,
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  scheduleExpressionForCroner,
  type TaskSchedulerScope,
} from '../index.js';

const model = { provider: 'test', model: 'test-model' };

describe('task scheduler', () => {
  it('normalizes interval, once, cron, and RRULE schedules', () => {
    expect(resolveScheduledTaskDefinition({ type: 'interval', schedule: '10m' })).toMatchObject({
      type: 'interval',
      schedule: '10m',
      intervalSeconds: 600,
    });
    expect(resolveScheduledTaskDefinition({ type: 'cron', schedule: '0 9 * * *' })).toMatchObject({
      type: 'cron',
      schedule: '0 9 * * *',
      intervalSeconds: 0,
    });
    expect(resolveScheduledTaskDefinition({ type: 'once', schedule: '+5m' }).schedule).toEqual(
      expect.stringMatching(/T.*Z$/),
    );
    expect(scheduleExpressionForCroner('RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=FR')).toBe(
      '30 7 * * 5',
    );
  });

  it('runs tasks through the injected runner and emits lifecycle hooks', async () => {
    const events: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async (task, run) => {
        events.push(`runner:${task.prompt}:${run.sessionId.startsWith('scheduled-run-')}`);
      },
      hooks: {
        onSchedulerStarted: () => {
          events.push('scheduler:start');
        },
        onTaskStarted: ({ task }) => {
          events.push(`task:start:${task.prompt}`);
        },
        onTaskCompleted: ({ task }) => {
          events.push(`task:done:${task.runCount}`);
        },
      },
    });

    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'check things',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();

    expect(events).toEqual([
      'scheduler:start',
      'task:start:check things',
      'runner:check things:true',
      'task:done:1',
    ]);
    expect((await scheduler.get(task.id))?.lastStatus).toBe('success');
  });

  it('does not run the same task concurrently', async () => {
    let starts = 0;
    let release: (() => void) | undefined;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        starts += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'slow check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(() => starts === 1);
    await scheduler.runNow(task.id);
    await delay(20);
    expect(starts).toBe(1);
    release?.();
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);
    await scheduler.stop();
  });

  it('records failed task runs and emits failure hooks', async () => {
    const failures: string[] = [];
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        throw new Error('nope');
      },
      hooks: {
        onTaskFailed: ({ error }) => {
          failures.push(error);
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'bad check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.lastStatus === 'error');

    const failed = await scheduler.get(task.id);
    expect(failed?.lastError).toBe('nope');
    expect(failed?.runHistory?.at(-1)).toMatchObject({ status: 'error', message: 'nope' });
    expect(failures).toEqual(['nope']);
    await scheduler.stop();
  });

  it('keeps task execution isolated from hook failures', async () => {
    let ran = false;
    const scheduler = new PersistentTaskScheduler({
      store: new MemoryScheduledTaskStore(),
      lock: new MemorySchedulerLock(),
      runner: async () => {
        ran = true;
      },
      hooks: {
        onTaskStarted: () => {
          throw new Error('hook failed');
        },
        onTaskCompleted: () => {
          throw new Error('hook failed too');
        },
      },
    });
    const task = await scheduler.create({
      sessionId: 'scheduled-1',
      prompt: 'hook check',
      type: 'interval',
      schedule: '1h',
      intervalSeconds: 3600,
      enabled: true,
      model,
      toolPolicyProfile: 'scheduled',
    });

    await scheduler.start();
    await scheduler.runNow(task.id);
    await waitFor(async () => (await scheduler.get(task.id))?.runCount === 1);

    const completed = await scheduler.get(task.id);
    expect(ran).toBe(true);
    expect(completed?.lastStatus).toBe('success');
    expect(completed?.lastError).toBeUndefined();
    await scheduler.stop();
  });
});

class MemoryScheduledTaskStore implements ScheduledTaskStore {
  readonly tasks = new Map<string, ScheduledTask>();

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    return [...this.tasks.values()].filter((task) => matchesScope(task, scope));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    const task = this.tasks.get(taskId);
    return task && matchesScope(task, scope) ? task : undefined;
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    this.tasks.set(task.id, task);
    return task;
  }

  async update(
    taskId: string,
    task: ScheduledTask,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    if (!(await this.get(taskId, scope))) {
      return undefined;
    }
    this.tasks.set(taskId, task);
    return task;
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    if (!(await this.get(taskId, scope))) {
      return false;
    }
    return this.tasks.delete(taskId);
  }
}

class MemorySchedulerLock implements SchedulerLock {
  readonly path = 'memory:scheduler';
  private locked = false;

  acquire(): boolean {
    if (this.locked) {
      return false;
    }
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

function matchesScope(task: ScheduledTask, scope: TaskSchedulerScope): boolean {
  return (
    (!scope.tenantId || task.tenantId === scope.tenantId) &&
    (!scope.userId || task.userId === scope.userId)
  );
}

async function waitFor(assertion: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (await assertion()) {
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for assertion');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
