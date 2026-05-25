import path from 'node:path';
import { loadPiSettings, resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  PersistentTaskScheduler,
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskRunner,
  type ScheduledTaskStore,
  type ScheduledTaskType,
  type SchedulerLock,
  type TaskScheduler,
} from './index.js';
import { FileSchedulerLock, JsonScheduledTaskStore } from './stores.js';

const SETTINGS_KEY = 'pi-scheduler';
const STATUS_KEY = 'pi-scheduler';

export type PiSchedulerExtensionConfig = {
  dataDir?: string;
  store?: ScheduledTaskStore;
  lock?: SchedulerLock;
  scheduler?: TaskScheduler;
};

type ResolvedConfig = {
  dataDir: string;
  store?: ScheduledTaskStore;
  lock?: SchedulerLock;
  scheduler?: TaskScheduler;
};

function resolveConfig(raw?: PiSchedulerExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveAgentDir(), 'data'),
  };
  if (raw?.store) resolved.store = raw.store;
  if (raw?.lock) resolved.lock = raw.lock;
  if (raw?.scheduler) resolved.scheduler = raw.scheduler;
  return resolved;
}

function loadSettings(cwd: string): PiSchedulerExtensionConfig | undefined {
  try {
    const config = loadPiSettings<Partial<PiSchedulerExtensionConfig>>(SETTINGS_KEY, {
      cwd,
      agentDir: resolveAgentDir(),
    });
    return Object.keys(config).length > 0 ? (config as PiSchedulerExtensionConfig) : undefined;
  } catch {
    return undefined;
  }
}

export default function taskSchedulerExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiSchedulerExtensionConfig,
): void {
  let scheduler: TaskScheduler | undefined;
  let ownsScheduler = false;

  pi.on('session_start', async (_event, ctx) => {
    const fileConfig = loadSettings(ctx.cwd);
    const config = resolveConfig({ ...fileConfig, ...injectedConfig });

    try {
      if (config.scheduler) {
        scheduler = config.scheduler;
        ownsScheduler = false;
      } else {
        const store = config.store ?? new JsonScheduledTaskStore(
          path.join(config.dataDir, 'tasks.json'),
        );
        const lock = config.lock ?? new FileSchedulerLock(
          path.join(config.dataDir, 'scheduler.lock'),
        );

        const runner: ScheduledTaskRunner = async (task) => {
          pi.sendUserMessage(task.prompt);
        };

        const instance = new PersistentTaskScheduler({ store, lock, runner });
        await instance.start();
        scheduler = instance;
        ownsScheduler = true;
      }

      ctx.ui.setStatus(STATUS_KEY, scheduler.isActive() ? 'scheduler: active' : 'scheduler: idle');
    } catch {
      ctx.ui.setStatus(STATUS_KEY, 'scheduler: unavailable');
    }
  });

  pi.on('session_shutdown', async () => {
    if (ownsScheduler) {
      await scheduler?.stop();
    }
    scheduler = undefined;
    ownsScheduler = false;
  });

  pi.registerCommand('pi-scheduler-status', {
    description: 'Show task scheduler status.',
    handler: async (_args, ctx) => {
      if (!scheduler) {
        ctx.ui.notify('Task scheduler is not running.', 'warning');
        return;
      }
      const status = await scheduler.status();
      ctx.ui.notify(formatStatus(status), 'info');
    },
  });

  pi.registerCommand('pi-scheduler-list', {
    description: 'List scheduled tasks.',
    handler: async (_args, ctx) => {
      if (!scheduler) {
        ctx.ui.notify('Task scheduler is not running.', 'warning');
        return;
      }
      const tasks = await scheduler.list();
      ctx.ui.notify(formatTaskList(tasks), 'info');
    },
  });

  pi.registerCommand('pi-scheduler-run-now', {
    description: 'Run a scheduled task immediately by ID.',
    handler: async (args, ctx) => {
      const taskId = args.trim();
      if (!taskId) {
        ctx.ui.notify('Usage: /pi-scheduler-run-now <task-id>', 'warning');
        return;
      }
      if (!scheduler) {
        ctx.ui.notify('Task scheduler is not running.', 'warning');
        return;
      }
      const task = await scheduler.runNow(taskId);
      if (!task) {
        ctx.ui.notify(`Task not found: ${taskId}`, 'error');
        return;
      }
      ctx.ui.notify(`Triggered: ${task.name ?? task.id}`, 'info');
    },
  });

  // --- LLM-callable tools ---

  const taskTypeSchema = Type.Union([
    Type.Literal('cron'),
    Type.Literal('once'),
    Type.Literal('interval'),
  ]);

  pi.registerTool({
    name: 'scheduler_create',
    label: 'Scheduler',
    description:
      'Create a scheduled task. Supports cron expressions, one-time (ISO timestamp or relative like "+10m"), and interval (e.g. "30s", "5m", "1h").',
    promptSnippet: 'Create scheduled tasks (cron/once/interval) that run prompts on a schedule.',
    parameters: Type.Object({
      type: taskTypeSchema,
      schedule: Type.String({
        description:
          'Schedule expression. Cron: "0 9 * * 1-5"; Once: ISO timestamp or "+10m"; Interval: "30s", "5m", "1h".',
      }),
      prompt: Type.String({ description: 'The prompt to execute when triggered.' }),
      name: Type.Optional(Type.String({ description: 'Human-readable task name.' })),
      description: Type.Optional(Type.String({ description: 'Task description.' })),
      enabled: Type.Optional(
        Type.Boolean({ description: 'Whether the task is enabled. Default true.' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!scheduler) {
        return textResult(
          'Task scheduler is not running. The extension may be disabled or failed to initialize.',
        );
      }
      try {
        const definition = resolveScheduledTaskDefinition({
          type: params.type as ScheduledTaskType,
          schedule: params.schedule,
        });
        const input: ScheduledTaskCreateInput = {
          ...definition,
          prompt: params.prompt,
          sessionId: ctx.sessionManager?.getSessionId?.() ?? 'unknown',
          model: {
            provider: 'anthropic',
            model: ctx.model?.id ?? 'unknown',
          },
          toolPolicyProfile: 'default',
          enabled: params.enabled !== false,
          ...(params.name ? { name: params.name } : {}),
          ...(params.description ? { description: params.description } : {}),
        };
        const task = await scheduler.create(input);
        return textResult(JSON.stringify(formatTaskSummary(task), null, 2));
      } catch (error) {
        return textResult(
          `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });

  pi.registerTool({
    name: 'scheduler_list',
    label: 'Scheduler',
    description: 'List all scheduled tasks with their status and next run time.',
    promptSnippet: 'List all scheduled tasks.',
    parameters: Type.Object({}),
    async execute() {
      if (!scheduler) {
        return textResult('Task scheduler is not running.');
      }
      const tasks = await scheduler.list();
      if (tasks.length === 0) {
        return textResult('No scheduled tasks.');
      }
      const summary = tasks.map(formatTaskSummary);
      return textResult(JSON.stringify(summary, null, 2));
    },
  });

  pi.registerTool({
    name: 'scheduler_get',
    label: 'Scheduler',
    description: 'Get detailed information about a scheduled task including run history.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The task ID to query.' }),
    }),
    async execute(_toolCallId, params) {
      if (!scheduler) {
        return textResult('Task scheduler is not running.');
      }
      const task = await scheduler.get(params.taskId);
      if (!task) {
        return textResult(`Task not found: ${params.taskId}`);
      }
      return textResult(JSON.stringify(task, null, 2));
    },
  });

  pi.registerTool({
    name: 'scheduler_update',
    label: 'Scheduler',
    description: 'Update a scheduled task. Can change schedule, prompt, name, or enable/disable.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The task ID to update.' }),
      type: Type.Optional(taskTypeSchema),
      schedule: Type.Optional(Type.String({ description: 'New schedule expression.' })),
      prompt: Type.Optional(Type.String({ description: 'New prompt.' })),
      name: Type.Optional(Type.String({ description: 'New name.' })),
      description: Type.Optional(Type.String({ description: 'New description.' })),
      enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable the task.' })),
    }),
    async execute(_toolCallId, params) {
      if (!scheduler) {
        return textResult('Task scheduler is not running.');
      }
      const { taskId, type, schedule, ...rest } = params;
      const update: Record<string, unknown> = { ...rest };
      if (type !== undefined || schedule !== undefined) {
        try {
          const existing = await scheduler.get(taskId);
          if (!existing) {
            return textResult(`Task not found: ${taskId}`);
          }
          const definition = resolveScheduledTaskDefinition({
            type: (type ?? existing.type) as ScheduledTaskType,
            schedule: schedule ?? existing.schedule,
          });
          Object.assign(update, definition);
        } catch (error) {
          return textResult(
            `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const task = await scheduler.update(taskId, update);
      if (!task) {
        return textResult(`Task not found: ${taskId}`);
      }
      return textResult(JSON.stringify(formatTaskSummary(task), null, 2));
    },
  });

  pi.registerTool({
    name: 'scheduler_delete',
    label: 'Scheduler',
    description: 'Delete a scheduled task.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The task ID to delete.' }),
    }),
    async execute(_toolCallId, params) {
      if (!scheduler) {
        return textResult('Task scheduler is not running.');
      }
      const deleted = await scheduler.delete(params.taskId);
      return textResult(
        deleted ? `Deleted task: ${params.taskId}` : `Task not found: ${params.taskId}`,
      );
    },
  });

  pi.registerTool({
    name: 'scheduler_run_now',
    label: 'Scheduler',
    description: 'Trigger immediate execution of a scheduled task.',
    parameters: Type.Object({
      taskId: Type.String({ description: 'The task ID to run immediately.' }),
    }),
    async execute(_toolCallId, params) {
      if (!scheduler) {
        return textResult('Task scheduler is not running.');
      }
      const task = await scheduler.runNow(params.taskId);
      if (!task) {
        return textResult(`Task not found: ${params.taskId}`);
      }
      return textResult(`Triggered: ${task.name ?? task.id}`);
    },
  });
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function formatTaskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    schedule: task.schedule,
    enabled: task.enabled,
    lastStatus: task.lastStatus ?? 'pending',
    nextRunAt: task.nextRunAt,
    runCount: task.runCount,
    prompt: task.prompt.length > 100 ? task.prompt.slice(0, 100) + '…' : task.prompt,
  };
}

function formatStatus(status: Awaited<ReturnType<TaskScheduler['status']>>): string {
  const lines = [
    `Active: ${status.active}`,
    `Tasks: ${status.taskCount}`,
    `Timers: ${status.scheduledTimerCount}`,
    `Crons: ${status.scheduledCronCount}`,
  ];
  if (status.runningTaskIds.length > 0) {
    lines.push(`Running: ${status.runningTaskIds.join(', ')}`);
  }
  return lines.join('\n');
}

function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) {
    return 'No scheduled tasks.';
  }
  return tasks
    .map((t) => {
      const name = t.name ?? t.id.slice(0, 8);
      const status = t.enabled ? (t.lastStatus ?? 'pending') : 'disabled';
      const next = t.nextRunAt ? ` next: ${t.nextRunAt}` : '';
      return `${name} [${t.type}] ${status}${next}`;
    })
    .join('\n');
}
