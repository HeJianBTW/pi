# @amaster.ai/pi-task-scheduler

Scheduled task domain types, execution scheduler, and pi agent extension.

The package owns schedule parsing, task lifecycle state, process-local timers,
runner callbacks, scheduler hooks, and LLM-callable tools for autonomous task
management.

## Storage

The package ships with a built-in file-based storage (default, zero external
dependencies):

- `JsonScheduledTaskStore` — persists tasks to a JSON file with atomic writes
- `FileSchedulerLock` — PID-based file lock for single-owner execution

For database-backed storage (multi-tenant, Prisma), use
`@amaster.ai/pi-storage/scheduler` which implements the same interfaces with
`DbScheduledTaskStore` and `RedisSchedulerLock`.

### Default (file storage)

```ts
import {
  PersistentTaskScheduler,
  JsonScheduledTaskStore,
  FileSchedulerLock,
} from "@amaster.ai/pi-task-scheduler";

const scheduler = new PersistentTaskScheduler({
  store: new JsonScheduledTaskStore("/var/lib/pi/tasks.json"),
  lock: new FileSchedulerLock("/var/lib/pi/tasks.lock"),
  runner: async (task, run) => {
    await runPrompt(task.prompt, { sessionId: run.sessionId });
  },
});

await scheduler.start();
```

### Database storage (pi-agent server)

```ts
import { PersistentTaskScheduler } from "@amaster.ai/pi-task-scheduler";
import {
  DbScheduledTaskStore,
  RedisSchedulerLock,
} from "@amaster.ai/pi-storage/scheduler";

const scheduler = new PersistentTaskScheduler({
  store: new DbScheduledTaskStore(databaseUrl),
  lock: new RedisSchedulerLock(redisUrl),
  runner: async (task, run) => {
    await runPrompt(task.prompt, { sessionId: run.sessionId });
  },
});

await scheduler.start();
```

## Extension

The package exports a pi extension that integrates with the agent runtime:

- **Lifecycle**: creates a `PersistentTaskScheduler` on `session_start`, stops on `session_shutdown`
- **Commands**: `/pi-scheduler-status`, `/pi-scheduler-list`, `/pi-scheduler-run-now`
- **LLM Tools**: `scheduler_create`, `scheduler_list`, `scheduler_get`, `scheduler_update`, `scheduler_delete`, `scheduler_run_now`

Configuration via settings key `pi-scheduler`:

```json
{
  "pi-scheduler": {
    "dataDir": "/custom/path"
  }
}
```

Data is stored in `<agentDir>/data/` by default (`~/.pi/agent/data/`).

### Standalone mode (default)

When installed as an npm extension package, the extension creates its own
scheduler with `JsonScheduledTaskStore` and `FileSchedulerLock`. No additional
dependencies required.

### Injected mode (pi-agent server)

When the host already owns a scheduler instance (e.g. pi-agent server with DB
storage), pass it directly to avoid creating a second scheduler:

```ts
import taskSchedulerExtension from "@amaster.ai/pi-task-scheduler";
import { PersistentTaskScheduler } from "@amaster.ai/pi-task-scheduler";
import {
  DbScheduledTaskStore,
  RedisSchedulerLock,
} from "@amaster.ai/pi-storage/scheduler";

const scheduler = new PersistentTaskScheduler({
  store: new DbScheduledTaskStore(databaseUrl),
  lock: new RedisSchedulerLock(redisUrl),
  runner,
});
await scheduler.start();

// Extension only registers tools, does not create/stop the scheduler
taskSchedulerExtension(pi, { scheduler });
```

In injected mode, `session_shutdown` does **not** stop the scheduler — the host
manages its lifecycle.

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
