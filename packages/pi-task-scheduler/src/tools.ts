import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskType,
  type TaskScheduler,
} from './index.js';

function textResult(text: string): AgentToolResult<unknown> {
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
    prompt: task.prompt.length > 100 ? `${task.prompt.slice(0, 100)}…` : task.prompt,
  };
}

const taskTypeSchema = Type.Union([
  Type.Literal('cron'),
  Type.Literal('once'),
  Type.Literal('interval'),
]);

export function createSchedulerTools(scheduler: TaskScheduler): ToolDefinition[] {
  return [
    {
      name: 'scheduler_create',
      label: 'Scheduler',
      description:
        'Schedule a prompt to be executed automatically at a future time or on a recurring basis. Supports cron expressions, one-time (ISO timestamp or relative like "+10m"), and interval (e.g. "30s", "5m", "1h"). Use this when the user wants something to run later, repeatedly, or on a timer.',
      promptSnippet:
        'Schedule prompts to run automatically via cron, one-time delay, or fixed interval.',
      parameters: Type.Object({
        type: taskTypeSchema,
        schedule: Type.String({
          description:
            'Schedule expression. Cron: "0 9 * * 1-5"; Once: ISO timestamp or "+10m"; Interval: "30s", "5m", "1h".',
        }),
        prompt: Type.String({ description: 'The prompt to execute when triggered.' }),
        name: Type.Optional(
          Type.String({ description: 'Human-readable name for this scheduled prompt.' }),
        ),
        description: Type.Optional(
          Type.String({ description: 'Description of this scheduled prompt.' }),
        ),
        enabled: Type.Optional(
          Type.Boolean({ description: 'Whether this scheduled prompt is enabled. Default true.' }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description: 'Maximum execution time in milliseconds. Defaults to 30 minutes.',
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback | undefined,
        ctx: ExtensionContext,
      ): Promise<AgentToolResult<unknown>> {
        try {
          const definition = resolveScheduledTaskDefinition({
            type: params.type as ScheduledTaskType,
            schedule: params.schedule as string,
          });
          const input: ScheduledTaskCreateInput = {
            ...definition,
            prompt: params.prompt as string,
            sessionId: ctx.sessionManager?.getSessionId?.() ?? 'unknown',
            model: {
              provider: ctx.model?.provider ?? 'anthropic',
              model: ctx.model?.id ?? 'unknown',
            },
            toolPolicyProfile: 'default',
            enabled: params.enabled !== false,
            ...(params.name ? { name: params.name as string } : {}),
            ...(params.description ? { description: params.description as string } : {}),
            ...(typeof params.timeoutMs === 'number'
              ? { timeoutMs: params.timeoutMs as number }
              : {}),
          };
          const task = await scheduler.create(input);
          return textResult(JSON.stringify(formatTaskSummary(task), null, 2));
        } catch (error) {
          return textResult(
            `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
    {
      name: 'scheduler_list',
      label: 'Scheduler',
      description: 'List all scheduled prompts with their status and next run time.',
      promptSnippet: 'List all scheduled prompts.',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult<unknown>> {
        const tasks = await scheduler.list();
        if (tasks.length === 0) {
          return textResult('No scheduled tasks.');
        }
        const summary = tasks.map(formatTaskSummary);
        return textResult(JSON.stringify(summary, null, 2));
      },
    },
    {
      name: 'scheduler_get',
      label: 'Scheduler',
      description:
        'Get detailed information about a scheduled prompt, including its schedule and run history.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to query.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> {
        const task = await scheduler.get(params.taskId as string);
        if (!task) {
          return textResult(`Task not found: ${params.taskId}`);
        }
        return textResult(JSON.stringify(task, null, 2));
      },
    },
    {
      name: 'scheduler_update',
      label: 'Scheduler',
      description:
        'Update a scheduled prompt. Can change schedule, prompt text, name, or enable/disable.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to update.' }),
        type: Type.Optional(taskTypeSchema),
        schedule: Type.Optional(Type.String({ description: 'New schedule expression.' })),
        prompt: Type.Optional(Type.String({ description: 'New prompt.' })),
        name: Type.Optional(Type.String({ description: 'New name.' })),
        description: Type.Optional(Type.String({ description: 'New description.' })),
        enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable.' })),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> {
        const { taskId, type, schedule, ...rest } = params as {
          taskId: string;
          type?: string;
          schedule?: string;
          [key: string]: unknown;
        };
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
    },
    {
      name: 'scheduler_delete',
      label: 'Scheduler',
      description: 'Delete a scheduled prompt.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to delete.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = params.taskId as string;
        const deleted = await scheduler.delete(taskId);
        return textResult(deleted ? `Deleted task: ${taskId}` : `Task not found: ${taskId}`);
      },
    },
    {
      name: 'scheduler_run_now',
      label: 'Scheduler',
      description: 'Trigger immediate execution of a scheduled prompt, ignoring its schedule.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to run immediately.' }),
      }),
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = params.taskId as string;
        const task = await scheduler.runNow(taskId);
        if (!task) {
          return textResult(`Task not found: ${taskId}`);
        }
        return textResult(`Triggered: ${task.name ?? task.id}`);
      },
    },
  ];
}
