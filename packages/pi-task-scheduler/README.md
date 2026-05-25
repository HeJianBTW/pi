# @amaster.ai/pi-task-scheduler

Scheduled task domain types, execution scheduler, and pi agent extension.

The package owns schedule parsing, task lifecycle state, process-local timers,
runner callbacks, scheduler hooks, and LLM-callable tools for autonomous task
management.

## Scope

This package does not persist data by itself and does not know how to execute a
pi chat turn. Applications provide both:

- a `ScheduledTaskStore` for persistence
- a `SchedulerLock` for single-owner execution
- a `ScheduledTaskRunner` callback for the actual work

Storage adapters live in `@amaster.ai/pi-storage/scheduler`.

## Extension

The package exports a pi extension that integrates with the agent runtime:

- **Lifecycle**: creates a `PersistentTaskScheduler` on `session_start`, stops on `session_shutdown`
- **Commands**: `/pi-scheduler-status`, `/pi-scheduler-list`, `/pi-scheduler-run-now`
- **LLM Tools**: `scheduler_create`, `scheduler_list`, `scheduler_get`, `scheduler_update`, `scheduler_delete`, `scheduler_run_now`

Configuration via settings key `pi-scheduler`:

```json
{
  "pi-scheduler": {
    "enabled": true,
    "dataDir": "/custom/path"
  }
}
```

Data is stored in `<agentDir>/data/` by default (`~/.pi/agent/data/`).

## Example

```ts
import { PersistentTaskScheduler } from "@amaster.ai/pi-task-scheduler";
import {
  FileSchedulerLock,
  JsonScheduledTaskStore,
} from "@amaster.ai/pi-storage/scheduler";

const scheduler = new PersistentTaskScheduler({
  store: new JsonScheduledTaskStore("/var/lib/pi/tasks.json"),
  lock: new FileSchedulerLock("/var/lib/pi/tasks.lock"),
  runner: async (task, run) => {
    await runPrompt(task.prompt, { sessionId: run.sessionId });
  },
  hooks: {
    onTaskFailed: ({ task, error }) => {
      console.warn("scheduled task failed", task.id, error);
    },
  },
});

await scheduler.start();
```

## Scheduling

Tasks support three schedule types:

- `interval`: duration strings such as `30s`, `10m`, `1h`, or `1d`
- `once`: ISO timestamps or relative values such as `+5m`
- `cron`: 5/6-field cron expressions and a small RRULE subset

The scheduler does not catch up missed runs after process downtime. When it
starts, it registers future timers for enabled tasks.

## Hooks

Hooks are best-effort observability callbacks. If a hook throws, the scheduler
swallows the error and keeps task state authoritative.
