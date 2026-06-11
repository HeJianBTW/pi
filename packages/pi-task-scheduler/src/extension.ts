import path from 'node:path';
import { loadPiSettings, resolveHome } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  PersistentTaskScheduler,
  type ScheduledTask,
  type ScheduledTaskRunner,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskScheduler,
} from './index.js';
import { FileSchedulerLock, JsonScheduledTaskStore } from './stores.js';
import { createSchedulerTools } from './tools.js';

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
    dataDir: raw?.dataDir?.trim() || path.join(resolveHome(), 'data'),
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
        const store =
          config.store ?? new JsonScheduledTaskStore(path.join(config.dataDir, 'tasks.json'));
        const lock =
          config.lock ?? new FileSchedulerLock(path.join(config.dataDir, 'scheduler.lock'));

        const runner: ScheduledTaskRunner = async (task) => {
          pi.sendUserMessage(task.prompt);
        };

        const instance = new PersistentTaskScheduler({ store, lock, runner });
        await instance.start();
        scheduler = instance;
        ownsScheduler = true;
      }

      ctx.ui.setStatus(STATUS_KEY, scheduler.isActive() ? 'scheduler: active' : 'scheduler: idle');

      // Register LLM-callable tools after scheduler is ready
      const tools = createSchedulerTools(scheduler);
      for (const tool of tools) {
        pi.registerTool(tool);
      }
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
