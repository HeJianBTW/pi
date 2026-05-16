import { randomUUID } from 'node:crypto';
import type {
  RuntimeLifecycleEvent as CoreRuntimeLifecycleEvent,
  RuntimeSession as CoreRuntimeSession,
  TranscriptStore as CoreTranscriptStore,
  JsonObject,
  JsonValue,
  RuntimeLlmGenerationEvent,
  RuntimeModelConfig,
  RuntimeRequestContext,
  RuntimeScope,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunStore,
  ToolSource,
} from '@amaster.ai/pi-types';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

export type {
  JsonObject,
  JsonValue,
  RuntimeLlmGenerationEvent,
  RuntimeModelConfig,
  RuntimeRequestContext,
  RuntimeScope,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunStore,
};

export type RuntimeSession = Omit<CoreRuntimeSession, 'sandboxStatus' | 'piSessionFile'> &
  Partial<Pick<CoreRuntimeSession, 'sandboxStatus' | 'piSessionFile'>>;

export type RuntimeLifecycleEvent = CoreRuntimeLifecycleEvent & {
  type: Extract<
    CoreRuntimeLifecycleEvent['type'],
    | 'subagent_spawned'
    | 'subagent_started'
    | 'subagent_completed'
    | 'subagent_failed'
    | 'subagent_cancelled'
  >;
};

export type TranscriptStore = Pick<CoreTranscriptStore, 'appendTurn'>;

export type SubagentRuntime = {
  createOrResumeSession(input: {
    request: RuntimeRequestContext;
    toolPolicyProfile: string;
    workspaceId?: string;
  }): Promise<{ runtime: RuntimeSession; pi: SubagentActivePiSession }>;
};

export type SubagentPolicyEngine = {
  decide(input: {
    request: RuntimeRequestContext;
    toolCall: {
      id: string;
      name: 'sessions_spawn';
      source: Extract<ToolSource, 'runtime'>;
      args: JsonObject;
    };
  }): {
    kind: 'allow' | 'allow_with_constraints' | 'sandbox_only' | 'ask' | 'deny';
    reason?: string;
  };
};

export type SubagentRole = {
  name: string;
  description: string;
  filePath: string;
  prompt: string;
  frontmatter: Record<string, string>;
};

export type SubagentRegistry = {
  roles: SubagentRole[];
  byName: Map<string, SubagentRole>;
};

export type SubagentRoutingMode = 'auto' | 'force' | 'off';

export type SpawnSubagentInput = {
  task: string;
  agent?: string;
  label?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  model?: Partial<RuntimeModelConfig> | string;
  provider?: string;
  thinkingLevel?: RuntimeModelConfig['thinkingLevel'];
  runTimeoutMs?: number;
  toolPolicyProfile?: string;
  context?: 'isolated';
};

export type SpawnSubagentResult =
  | { status: 'completed'; run: SubagentRun; result: string }
  | { status: 'forbidden' | 'error'; error: string };

export type SubagentActivePiSession = {
  messages: readonly unknown[];
  abort?: () => Promise<unknown>;
  dispose: () => void;
};

export type SubagentActiveSession = {
  traceId?: string;
  runtime: RuntimeSession;
  pi: SubagentActivePiSession;
  cancelledReason?: string;
  childRunIds?: Set<string>;
  completedSubagentRunIds?: string[];
};

export type ActiveSessionInput = {
  sessionId: string;
  conversationId: string;
  traceId?: string;
  trigger?: RuntimeRequestContext['trigger'];
  senderTrust?: RuntimeRequestContext['senderTrust'];
  interactive?: boolean;
  model: RuntimeModelConfig;
  toolPolicyProfile: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
};

export type SubagentLogger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export type SubagentMetrics = {
  subagentsSpawnedTotal: number;
  subagentTurnsCompletedTotal: number;
  subagentTurnsFailedTotal: number;
  subagentsCancelledTotal: number;
};

export type RuntimeLifecycleEventRecorder = (event: RuntimeLifecycleEvent) => Promise<void>;
export type RuntimeLlmGenerationEventRecorder = (event: RuntimeLlmGenerationEvent) => Promise<void>;

export type PromptSubagentTurn = (
  active: SubagentActiveSession,
  message: string,
  timeoutMs: number,
  maxToolResults: number,
  images: readonly unknown[],
  telemetry: {
    input: string;
    recordRuntimeEvent: RuntimeLifecycleEventRecorder;
    recordLlmGenerationEvent: RuntimeLlmGenerationEventRecorder;
    parentSessionId: string;
    childSessionId: string;
    runId: string;
    spawnBatchId?: string;
    taskRunId: string;
  },
) => Promise<void>;

export type AssistantOutput = {
  text: string;
  stopReason?: string;
  errorMessage?: string;
};

export type SpawnSubagentDeps = {
  request: RuntimeRequestContext;
  input: SpawnSubagentInput;
  defaultModel: RuntimeModelConfig;
  runtime: SubagentRuntime;
  activeSessions: Map<string, SubagentActiveSession>;
  parentActive?: SubagentActiveSession;
  parentToolCallId?: string;
  subagents: SubagentRunStore;
  subagentRegistry: SubagentRegistry;
  turnCoordinator: {
    run<T>(
      input: {
        sessionId: string;
        source: 'subagent';
        tenantId: string;
        userId?: string;
        workspaceId?: string;
      },
      handler: () => Promise<T>,
    ): Promise<T>;
  };
  ensureRuntimeModelAvailable: (model: RuntimeModelConfig) => void;
  limits: { maxDepth: number; maxChildrenPerSession: number; timeoutMs: number };
  chatTurnTimeoutMs: number;
  maxSubagentToolResultsPerTurn: number;
  transcripts: TranscriptStore;
  recordRuntimeEvent: RuntimeLifecycleEventRecorder;
  recordLlmGenerationEvent: RuntimeLlmGenerationEventRecorder;
  logger: SubagentLogger;
  metrics: SubagentMetrics;
  cancelChildSubagentsForParent: (
    scope: RuntimeScope,
    parentSessionId: string,
    reason: string,
  ) => Promise<number>;
  promptSubagentTurn: PromptSubagentTurn;
  extractLastAssistant: (messages: readonly unknown[]) => AssistantOutput;
};

export function createSubagentToolDefinitions(options: {
  request: RuntimeRequestContext;
  getActive?: () => SubagentActiveSession | undefined;
  policy: SubagentPolicyEngine;
  subagents: SubagentRegistry;
  parseThinkingLevel: (
    value: string | undefined,
  ) => NonNullable<RuntimeModelConfig['thinkingLevel']>;
  spawnSubagent: (
    input: SpawnSubagentInput,
    parentActive?: SubagentActiveSession,
    parentToolCallId?: string,
  ) => Promise<SpawnSubagentResult>;
}): ToolDefinition[] {
  const parameters = Type.Object({
    agent: Type.Optional(
      Type.String({ description: subagentToolAgentDescription(options.subagents) }),
    ),
    task: Type.String({
      description:
        'Task to run in an isolated child subagent session. The parent turn waits for the final result.',
    }),
    label: Type.Optional(
      Type.String({ description: 'Short human-readable label for the subagent run.' }),
    ),
    model: Type.Optional(
      Type.String({ description: 'Optional model override. Use model or provider/model.' }),
    ),
    provider: Type.Optional(
      Type.String({ description: 'Optional provider override when model has no provider prefix.' }),
    ),
    thinkingLevel: Type.Optional(Type.String({ description: 'Optional thinking level override.' })),
    runTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    context: Type.Optional(
      Type.String({ description: 'Only "isolated" is supported in this runtime slice.' }),
    ),
  });

  return [
    defineTool({
      name: 'sessions_spawn',
      label: 'spawn subagent',
      description: subagentToolDescription(options.subagents),
      promptSnippet: subagentToolPromptSnippet(options.subagents),
      parameters,
      async execute(toolCallId, params) {
        assertSubagentToolAllowed(
          options.policy,
          options.request,
          toolCallId,
          params as JsonObject,
        );
        if (params.context !== undefined && params.context !== 'isolated') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { status: 'forbidden', error: 'Only context="isolated" is currently supported' },
                  null,
                  2,
                ),
              },
            ],
            details: { status: 'forbidden' },
          };
        }
        const result = await options.spawnSubagent(
          {
            task: params.task,
            ...(params.agent ? { agent: params.agent } : {}),
            ...(params.label ? { label: params.label } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.provider ? { provider: params.provider } : {}),
            ...(params.thinkingLevel
              ? { thinkingLevel: options.parseThinkingLevel(params.thinkingLevel) }
              : {}),
            ...(params.runTimeoutMs ? { runTimeoutMs: params.runTimeoutMs } : {}),
            ...(params.context === 'isolated' ? { context: 'isolated' } : {}),
          },
          options.getActive?.(),
          toolCallId,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: summarizeSubagentToolResult(result),
        };
      },
    }),
  ];
}

export async function spawnSubagentRun(deps: SpawnSubagentDeps): Promise<SpawnSubagentResult> {
  const task = deps.input.task.trim();
  const baseLogFields = {
    traceId: deps.request.traceId,
    parentSessionId: deps.request.sessionId,
    conversationId: deps.request.conversationId,
    tenantId: deps.request.tenantId,
    userId: deps.request.userId,
    workspaceId: deps.request.workspaceId,
    requestedAgent: deps.input.agent,
    label: deps.input.label,
    taskChars: task.length,
  };
  const scope: RuntimeScope = {
    tenantId: deps.request.tenantId ?? 'default',
    ...(deps.request.userId ? { userId: deps.request.userId } : {}),
  };
  if (!task) {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      reason: 'task is required',
    });
    return { status: 'error', error: 'task is required' };
  }
  if (deps.input.context && deps.input.context !== 'isolated') {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      context: deps.input.context,
      reason: 'Only context="isolated" is currently supported',
    });
    return { status: 'forbidden', error: 'Only context="isolated" is currently supported' };
  }
  const role = resolveSubagentRole(deps.subagentRegistry, deps.input.agent);
  if (typeof role === 'string') {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      reason: role,
    });
    return { status: 'error', error: role };
  }

  const parentDepth = await deps.subagents.getDepthForSession(scope, deps.request.sessionId);
  if (parentDepth >= deps.limits.maxDepth) {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      parentDepth,
      maxDepth: deps.limits.maxDepth,
      reason: 'max depth reached',
    });
    return {
      status: 'forbidden',
      error: `sessions_spawn is not allowed at this depth (current depth: ${parentDepth}, max: ${deps.limits.maxDepth})`,
    };
  }
  const activeChildren = await deps.subagents.countActiveChildren(scope, deps.request.sessionId);
  if (activeChildren >= deps.limits.maxChildrenPerSession) {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      activeChildren,
      maxChildrenPerSession: deps.limits.maxChildrenPerSession,
      reason: 'max active children reached',
    });
    return {
      status: 'forbidden',
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${deps.limits.maxChildrenPerSession})`,
    };
  }

  const model = resolveSubagentModel(deps.request.model ?? deps.defaultModel, deps.input);
  try {
    deps.ensureRuntimeModelAvailable(model);
  } catch (error) {
    deps.logger.warn('subagent_spawn_rejected', {
      ...baseLogFields,
      model,
      ...errorLogFields(error),
    });
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }

  const childSessionId = `${deps.request.sessionId}:subagent:${randomUUID()}`;
  const spawnBatchId = deps.input.spawnBatchId ?? defaultSubagentSpawnBatchId(deps.request);
  const run = await deps.subagents.create({
    ...scope,
    ...(deps.request.traceId ? { traceId: deps.request.traceId } : {}),
    spawnBatchId,
    ...(deps.input.taskRunId ? { taskRunId: deps.input.taskRunId } : {}),
    parentSessionId: deps.request.sessionId,
    childSessionId,
    ...(deps.parentToolCallId ? { parentToolCallId: deps.parentToolCallId } : {}),
    task,
    ...(role ? { agent: role.name } : {}),
    ...(deps.input.label ? { label: deps.input.label } : {}),
    depth: parentDepth + 1,
    model,
    toolPolicyProfile: deps.input.toolPolicyProfile ?? 'subagent',
    context: 'isolated',
  });
  deps.logger.info('subagent_spawned', {
    ...baseLogFields,
    runId: run.runId,
    taskRunId: run.taskRunId ?? run.runId,
    spawnBatchId,
    childSessionId,
    agent: run.agent,
    depth: run.depth,
    model,
    toolPolicyProfile: run.toolPolicyProfile,
  });
  deps.metrics.subagentsSpawnedTotal += 1;
  await deps.recordRuntimeEvent({
    id: randomUUID(),
    ...(run.traceId ? { traceId: run.traceId } : {}),
    type: 'subagent_spawned',
    sessionId: run.parentSessionId,
    conversationId: deps.request.conversationId,
    parentSessionId: run.parentSessionId,
    childSessionId: run.childSessionId,
    runId: run.runId,
    taskRunId: run.taskRunId ?? run.runId,
    ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
    ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
    createdAt: run.createdAt,
    model: run.model,
    toolPolicyProfile: run.toolPolicyProfile,
    details: {
      depth: run.depth,
      input: toTelemetryText(run.task),
      taskRunId: run.taskRunId ?? run.runId,
      ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
      ...(run.agent ? { agent: run.agent } : {}),
      ...(run.label ? { label: run.label } : {}),
    },
  });

  if (deps.parentActive) {
    deps.parentActive.childRunIds ??= new Set();
    deps.parentActive.childRunIds.add(run.runId);
  }

  try {
    const completed = await runSubagentTurn(deps, run);
    if (completed.status === 'completed') {
      if (deps.parentActive) {
        deps.parentActive.completedSubagentRunIds ??= [];
        deps.parentActive.completedSubagentRunIds.push(completed.runId);
      }
      return { status: 'completed', run: completed, result: completed.result ?? '' };
    }
    if (completed.status === 'failed') {
      deps.logger.error('subagent_run_returned_failed', {
        ...baseLogFields,
        runId: completed.runId,
        childSessionId: completed.childSessionId,
        errorMessage: completed.error,
      });
      return { status: 'error', error: completed.error ?? 'subagent failed' };
    }
    if (completed.status === 'cancelled') {
      deps.logger.warn('subagent_run_returned_cancelled', {
        ...baseLogFields,
        runId: completed.runId,
        childSessionId: completed.childSessionId,
        errorMessage: completed.error,
      });
      return { status: 'error', error: completed.error ?? 'subagent cancelled' };
    }
    deps.logger.warn('subagent_run_returned_unexpected_status', {
      ...baseLogFields,
      runId: completed.runId,
      childSessionId: completed.childSessionId,
      status: completed.status,
    });
    return { status: 'error', error: `subagent ended with unexpected status: ${completed.status}` };
  } finally {
    deps.parentActive?.childRunIds?.delete(run.runId);
  }
}

export async function runSubagentTurn(
  deps: SpawnSubagentDeps,
  run: SubagentRun,
): Promise<SubagentRun> {
  if (!deps.request.tenantId) {
    throw new Error('Subagent turn requires tenantId');
  }
  const tenantId = deps.request.tenantId;
  return await deps.turnCoordinator.run(
    {
      sessionId: run.childSessionId,
      source: 'subagent',
      tenantId,
      ...(deps.request.userId ? { userId: deps.request.userId } : {}),
      ...(deps.request.workspaceId ? { workspaceId: deps.request.workspaceId } : {}),
    },
    async () => {
      const scope: RuntimeScope = {
        tenantId,
        ...(deps.request.userId ? { userId: deps.request.userId } : {}),
      };
      const latest = await deps.subagents.get(scope, run.runId);
      if (!latest || latest.status === 'cancelled') {
        deps.logger.warn('subagent_turn_skipped', {
          traceId: run.traceId,
          runId: run.runId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          status: latest?.status ?? 'missing',
        });
        return latest ?? run;
      }
      await deps.subagents.markRunning(scope, run.runId);
      deps.logger.info('subagent_turn_started', {
        traceId: run.traceId,
        runId: run.runId,
        taskRunId: run.taskRunId ?? run.runId,
        spawnBatchId: run.spawnBatchId,
        parentToolCallId: run.parentToolCallId,
        parentSessionId: run.parentSessionId,
        childSessionId: run.childSessionId,
        agent: run.agent,
        label: run.label,
        depth: run.depth,
        model: run.model,
        toolPolicyProfile: run.toolPolicyProfile,
        taskChars: run.task.length,
      });
      const startedAt = Date.now();
      let active: SubagentActiveSession | undefined;
      try {
        active = await getOrCreateActiveSession(deps.activeSessions, deps.runtime, {
          sessionId: run.childSessionId,
          conversationId: run.childSessionId,
          ...(run.traceId ? { traceId: run.traceId } : {}),
          trigger: deps.request.trigger,
          senderTrust: deps.request.senderTrust,
          interactive: deps.request.interactive,
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
          ...(deps.request.tenantId ? { tenantId: deps.request.tenantId } : {}),
          ...(deps.request.userId ? { userId: deps.request.userId } : {}),
          ...(deps.request.workspaceId ? { workspaceId: deps.request.workspaceId } : {}),
        });
        await deps.recordRuntimeEvent({
          id: randomUUID(),
          ...(run.traceId ? { traceId: run.traceId } : {}),
          type: 'subagent_started',
          sessionId: run.childSessionId,
          conversationId: run.childSessionId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
          ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
          createdAt: new Date().toISOString(),
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          details: {
            ...(run.agent ? { agent: run.agent } : {}),
          },
        });
        const role = run.agent ? deps.subagentRegistry.byName.get(run.agent) : undefined;
        const subagentPrompt = buildSubagentPrompt({
          parentSessionId: run.parentSessionId,
          ...(role ? { role } : {}),
          ...(run.label ? { label: run.label } : {}),
          task: run.task,
        });
        await deps.promptSubagentTurn(
          active,
          subagentPrompt,
          resolveSubagentTurnTimeoutMs(
            deps.input.runTimeoutMs,
            deps.limits.timeoutMs,
            deps.chatTurnTimeoutMs,
          ),
          deps.maxSubagentToolResultsPerTurn,
          [],
          {
            input: toTelemetryText(run.task),
            recordRuntimeEvent: deps.recordRuntimeEvent,
            recordLlmGenerationEvent: deps.recordLlmGenerationEvent,
            parentSessionId: run.parentSessionId,
            childSessionId: run.childSessionId,
            runId: run.runId,
            taskRunId: run.taskRunId ?? run.runId,
            ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
          },
        );
        const assistant = deps.extractLastAssistant(active.pi.messages);
        await deps.transcripts.appendTurn({
          id: randomUUID(),
          sessionId: run.childSessionId,
          conversationId: run.childSessionId,
          userMessage: run.task,
          assistantMessage: assistant.text,
          model: run.model,
          ...(run.traceId ? { traceId: run.traceId } : {}),
          createdAt: new Date().toISOString(),
        });
        if (assistant.errorMessage) {
          const failed = await deps.subagents.markFailed(scope, run.runId, assistant.errorMessage);
          deps.logger.error('subagent_turn_failed', {
            traceId: run.traceId,
            runId: run.runId,
            taskRunId: run.taskRunId ?? run.runId,
            spawnBatchId: run.spawnBatchId,
            parentSessionId: run.parentSessionId,
            childSessionId: run.childSessionId,
            agent: run.agent,
            model: run.model,
            toolPolicyProfile: run.toolPolicyProfile,
            durationMs: Date.now() - startedAt,
            stopReason: assistant.stopReason,
            errorMessage: assistant.errorMessage,
          });
          deps.metrics.subagentTurnsFailedTotal += 1;
          await deps.recordRuntimeEvent({
            id: randomUUID(),
            ...(run.traceId ? { traceId: run.traceId } : {}),
            type: 'subagent_failed',
            sessionId: run.childSessionId,
            conversationId: run.childSessionId,
            parentSessionId: run.parentSessionId,
            childSessionId: run.childSessionId,
            runId: run.runId,
            taskRunId: run.taskRunId ?? run.runId,
            ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
            ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
            createdAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            model: run.model,
            toolPolicyProfile: run.toolPolicyProfile,
            error: assistant.errorMessage,
            details: {
              output: { error: assistant.errorMessage },
              taskRunId: run.taskRunId ?? run.runId,
              ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
              ...(run.agent ? { agent: run.agent } : {}),
              ...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}),
            },
          });
          return failed ?? run;
        }
        const completed = await deps.subagents.markCompleted(scope, run.runId, assistant.text);
        deps.logger.info('subagent_turn_completed', {
          traceId: run.traceId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          spawnBatchId: run.spawnBatchId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          agent: run.agent,
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          durationMs: Date.now() - startedAt,
          outputChars: assistant.text.length,
        });
        deps.metrics.subagentTurnsCompletedTotal += 1;
        await deps.recordRuntimeEvent({
          id: randomUUID(),
          ...(run.traceId ? { traceId: run.traceId } : {}),
          type: 'subagent_completed',
          sessionId: run.childSessionId,
          conversationId: run.childSessionId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
          ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
          createdAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          details: {
            output: toTelemetryText(assistant.text),
            taskRunId: run.taskRunId ?? run.runId,
            ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
            ...(run.agent ? { agent: run.agent } : {}),
          },
        });
        return completed ?? run;
      } catch (error) {
        const current = await deps.subagents.get(scope, run.runId);
        if (current?.status === 'cancelled') {
          deps.logger.warn('subagent_turn_cancelled', {
            traceId: run.traceId,
            runId: run.runId,
            parentSessionId: run.parentSessionId,
            childSessionId: run.childSessionId,
            durationMs: Date.now() - startedAt,
            errorMessage: current.error,
          });
          return current;
        }
        const message = error instanceof Error ? error.message : String(error);
        const failed = await deps.subagents.markFailed(scope, run.runId, message);
        deps.logger.error('subagent_turn_failed', {
          traceId: run.traceId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          spawnBatchId: run.spawnBatchId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          agent: run.agent,
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          durationMs: Date.now() - startedAt,
          ...errorLogFields(error),
        });
        deps.metrics.subagentTurnsFailedTotal += 1;
        await deps.recordRuntimeEvent({
          id: randomUUID(),
          ...(run.traceId ? { traceId: run.traceId } : {}),
          type: 'subagent_failed',
          sessionId: run.childSessionId,
          conversationId: run.childSessionId,
          parentSessionId: run.parentSessionId,
          childSessionId: run.childSessionId,
          runId: run.runId,
          taskRunId: run.taskRunId ?? run.runId,
          ...(run.spawnBatchId ? { spawnBatchId: run.spawnBatchId } : {}),
          ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
          createdAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          model: run.model,
          toolPolicyProfile: run.toolPolicyProfile,
          error: message,
        });
        return failed ?? run;
      } finally {
        if (active) {
          active.pi.dispose();
          deps.activeSessions.delete(run.childSessionId);
        }
      }
    },
  );
}

export function resolveSubagentTurnTimeoutMs(
  requestedTimeoutMs: number | undefined,
  configuredTimeoutMs: number | undefined,
  chatTurnTimeoutMs: number,
): number {
  const fallback = configuredTimeoutMs ?? chatTurnTimeoutMs;
  if (!requestedTimeoutMs) {
    return fallback;
  }
  return Math.max(requestedTimeoutMs, fallback);
}

export function buildSubagentPrompt(input: {
  parentSessionId: string;
  role?: SubagentRole;
  label?: string;
  task: string;
}): string {
  return [
    'You are a child subagent spawned by a parent copilot session.',
    `Parent session: ${input.parentSessionId}`,
    ...(input.role
      ? [`Subagent role: ${input.role.name}`, `Role description: ${input.role.description}`]
      : []),
    ...(input.label ? [`Label: ${input.label}`] : []),
    'Work independently. Use tools when useful, but keep tool use focused and stop once you have enough information.',
    'Return a concise final result for the parent session. Do not write memory unless the task explicitly asks for it.',
    'For analysis tasks, do not scaffold demo projects or write files unless the task explicitly requires file changes.',
    'You are already a child subagent. Do not spawn additional subagents.',
    ...(input.role ? ['', 'Role instructions:', input.role.prompt] : []),
    '',
    'Task:',
    input.task,
  ].join('\n');
}

export function resolveSubagentModel(
  parentModel: RuntimeModelConfig,
  input: SpawnSubagentInput,
): RuntimeModelConfig {
  const override =
    typeof input.model === 'string' ? parseModelRef(input.model, input.provider) : input.model;
  return mergeModel(parentModel, {
    ...(override ?? {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
  });
}

export async function getCompletedSubagentResults(
  active: SubagentActiveSession,
  subagents: SubagentRunStore,
): Promise<JsonObject[]> {
  const runIds = active.completedSubagentRunIds ?? [];
  if (runIds.length === 0) {
    return [];
  }
  const results: JsonObject[] = [];
  const scope = runtimeScope(active.runtime);
  for (const runId of runIds) {
    const run = await subagents.get(scope, runId);
    if (!run || run.status !== 'completed') {
      continue;
    }
    results.push({
      runId: run.runId,
      parentSessionId: run.parentSessionId,
      childSessionId: run.childSessionId,
      ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
      ...(run.agent ? { agent: run.agent } : {}),
      ...(run.label ? { label: run.label } : {}),
      status: run.status,
      task: toTelemetryText(run.task),
      result: toTelemetryText(run.result ?? ''),
      createdAt: run.createdAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      model: `${run.model.provider}/${run.model.model}`,
      ...(run.model.thinkingLevel ? { thinkingLevel: run.model.thinkingLevel } : {}),
    });
  }
  return results;
}

export async function cancelActiveChildSubagents(input: {
  scope: RuntimeScope;
  parentSessionId: string;
  activeSessions: Map<string, SubagentActiveSession>;
  subagents: SubagentRunStore;
  recordRuntimeEvent: RuntimeLifecycleEventRecorder;
  logger: SubagentLogger;
  metrics: SubagentMetrics;
  reason: string;
}): Promise<number> {
  const runs = await input.subagents.list(input.scope, input.parentSessionId);
  let cancelled = 0;
  for (const run of runs) {
    if (!isActiveSubagentStatus(run.status)) {
      continue;
    }
    const marked = await input.subagents.markCancelled(input.scope, run.runId, input.reason);
    if (!marked || marked.status !== 'cancelled') {
      continue;
    }
    cancelled += 1;
    input.metrics.subagentsCancelledTotal += 1;
    input.logger.warn('subagent_cancelled', {
      traceId: run.traceId,
      runId: run.runId,
      taskRunId: run.taskRunId ?? run.runId,
      spawnBatchId: run.spawnBatchId,
      parentToolCallId: run.parentToolCallId,
      parentSessionId: run.parentSessionId,
      childSessionId: run.childSessionId,
      agent: run.agent,
      model: run.model,
      toolPolicyProfile: run.toolPolicyProfile,
      reason: input.reason,
    });
    const childActive = input.activeSessions.get(run.childSessionId);
    if (childActive) {
      childActive.cancelledReason = input.reason;
      abortPiSession(childActive.pi);
    }
    await input.recordRuntimeEvent({
      id: randomUUID(),
      ...(run.traceId ? { traceId: run.traceId } : {}),
      type: 'subagent_cancelled',
      sessionId: run.childSessionId,
      conversationId: run.childSessionId,
      parentSessionId: run.parentSessionId,
      childSessionId: run.childSessionId,
      runId: run.runId,
      ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
      createdAt: new Date().toISOString(),
      model: run.model,
      toolPolicyProfile: run.toolPolicyProfile,
      error: input.reason,
      details: { reason: input.reason },
    });
  }
  return cancelled;
}

export function formatSubagentRoleSummary(role: SubagentRole): JsonObject {
  return {
    name: role.name,
    description: role.description,
    ...(role.frontmatter.thinking ? { thinking: role.frontmatter.thinking } : {}),
    ...(role.frontmatter.systemPromptMode
      ? { systemPromptMode: role.frontmatter.systemPromptMode }
      : {}),
    ...(role.frontmatter.defaultContext ? { defaultContext: role.frontmatter.defaultContext } : {}),
  };
}

export function subagentToolAgentDescription(subagents: SubagentRegistry): string {
  if (subagents.roles.length === 0) {
    return 'Optional named subagent role. Omit for a generic isolated child agent.';
  }
  return `Optional named subagent role. Available roles: ${subagents.roles.map((role) => role.name).join(', ')}. Omit for a generic isolated child agent.`;
}

export function subagentToolDescription(subagents: SubagentRegistry): string {
  const base =
    'Run an isolated child subagent for focused work and wait for its concise final result before continuing the parent turn.';
  if (subagents.roles.length === 0) {
    return base;
  }
  return `${base} You may set agent to one of: ${subagents.roles.map((role) => `${role.name} (${role.description})`).join('; ')}.`;
}

export function subagentToolPromptSnippet(subagents: SubagentRegistry): string {
  if (subagents.roles.length === 0) {
    return 'Use sessions_spawn to delegate focused work to a child subagent and wait for the result.';
  }
  return `Use sessions_spawn to delegate focused work. Choose a named agent when a role fits: ${subagents.roles.map((role) => role.name).join(', ')}.`;
}

export function resolveSubagentRole(
  registry: SubagentRegistry,
  requestedAgent: string | undefined,
): SubagentRole | undefined | string {
  const name = requestedAgent?.trim();
  if (!name) {
    return undefined;
  }
  const role = registry.byName.get(name) ?? registry.byName.get(name.toLowerCase());
  if (!role) {
    const available = registry.roles.map((candidate) => candidate.name).join(', ');
    return available
      ? `subagent role not found: ${name}. Available roles: ${available}`
      : `subagent role not found: ${name}. No roles are configured.`;
  }
  return role;
}

export function isSubagentSessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.includes(':subagent:'));
}

export function isSubagentRuntimeSession(session: RuntimeSession | undefined): boolean {
  return Boolean(session?.parentSessionId) || isSubagentSessionId(session?.sessionId);
}

export function runtimeScope(runtime: Pick<RuntimeSession, 'tenantId' | 'userId'>): RuntimeScope {
  return {
    tenantId: runtime.tenantId ?? 'default',
    ...(runtime.userId ? { userId: runtime.userId } : {}),
  };
}

export function isSubagentRuntimeRequest(
  request: Pick<RuntimeRequestContext, 'sessionId' | 'parentSessionId'>,
): boolean {
  return Boolean(request.parentSessionId) || isSubagentSessionId(request.sessionId);
}

export function shouldExposeSubagentTool(
  toolPolicyProfile: string,
  maxDepth: number,
  isToolExposed: (toolName: string, policy: unknown) => boolean,
  resolveToolExposurePolicy: (profile: string) => unknown,
): boolean {
  if (maxDepth <= 0) {
    return false;
  }
  return isToolExposed('sessions_spawn', resolveToolExposurePolicy(toolPolicyProfile));
}

export function applySubagentRoutingGuidance(
  message: string,
  options: {
    originalMessage: string;
    subagentMode: SubagentRoutingMode;
    canUseSubagent: boolean;
  },
): { message: string; applied: boolean; reason?: string } {
  if (!options.canUseSubagent || options.subagentMode === 'off') {
    return { message, applied: false };
  }
  const reason =
    options.subagentMode === 'force'
      ? 'force'
      : inferSubagentRoutingReason(options.originalMessage);
  if (!reason) {
    return { message, applied: false };
  }
  return {
    message: [
      '<copilot-routing-hint>',
      'The backend classified this request as likely decomposable, but you should still use your own judgment.',
      'If independent subtasks would improve quality or latency, call `sessions_spawn` early with narrow tasks and then continue in the parent session using the child results.',
      'Prefer one child per genuinely independent slice, such as UX/page mapping, data and mock planning, implementation slicing, research, or validation.',
      'When multiple slices are independent, spawn them in the same tool-use step so they can run in parallel.',
      `Routing reason: ${reason}.`,
      '</copilot-routing-hint>',
      '',
      message,
    ].join('\n'),
    applied: true,
    reason,
  };
}

export function inferSubagentRoutingReason(message: string): string | undefined {
  const normalized = message.toLowerCase();
  const hasResearch =
    /深度|调研|研究|分析|对比|评估|梳理|research|investigate|analysis|compare/.test(normalized);
  const hasReport = /报告|方案|总结|文档|report|proposal|document/.test(normalized);
  const hasPresentation = /ppt|presentation|slide|slides|演示|汇报/.test(normalized);
  const hasImplementation = /实现|开发|创建|生成|写一份|write|create|build|implement/.test(
    normalized,
  );
  const hasAppSurface =
    /系统|平台|应用|app|网站|后台|前端|页面|dashboard|console|portal|管理|crm|erp|saas/.test(
      normalized,
    );
  const hasMultipleFeatureCue =
    /包含|包括|基础功能|功能|模块|页面|流程|工作流|增删改查|crud|列表|表单|详情|权限|角色|mock|数据|后端|frontend|backend/.test(
      normalized,
    );
  if (hasResearch && hasReport && hasPresentation) {
    return 'deep-research-report-presentation';
  }
  if (hasResearch && (hasReport || hasPresentation || hasImplementation)) {
    return 'research-plus-deliverable';
  }
  if (hasReport && hasPresentation) {
    return 'multi-deliverable';
  }
  if (hasImplementation && hasAppSurface && hasMultipleFeatureCue) {
    return 'multi-part-application-build';
  }
  if (hasImplementation && hasAppSurface && normalized.length >= 20) {
    return 'application-build';
  }
  return undefined;
}

export async function getOrCreateActiveSession<
  TActive extends SubagentActiveSession = SubagentActiveSession,
>(
  activeSessions: Map<string, TActive>,
  runtime: SubagentRuntime,
  input: ActiveSessionInput,
): Promise<TActive> {
  const active = activeSessions.get(input.sessionId);
  if (
    active &&
    active.traceId === input.traceId &&
    sameModel(active.runtime.model, input.model) &&
    active.runtime.toolPolicyProfile === input.toolPolicyProfile &&
    active.runtime.tenantId === input.tenantId &&
    active.runtime.userId === input.userId &&
    active.runtime.workspaceId === input.workspaceId &&
    activeSessionLineageMatches(active.runtime, input)
  ) {
    return active;
  }
  active?.pi.dispose();
  const created = (await createActiveSession(runtime, input)) as TActive;
  activeSessions.set(input.sessionId, created);
  return created;
}

export async function createActiveSession(
  runtime: SubagentRuntime,
  input: ActiveSessionInput,
): Promise<SubagentActiveSession> {
  const request: RuntimeRequestContext = {
    ...(input.traceId ? { traceId: input.traceId } : {}),
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    trigger: input.trigger ?? 'user',
    senderTrust: input.senderTrust ?? 'owner',
    interactive: input.interactive ?? true,
    model: input.model,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.spawnBatchId ? { spawnBatchId: input.spawnBatchId } : {}),
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
  };
  const created = await runtime.createOrResumeSession({
    request,
    toolPolicyProfile: input.toolPolicyProfile,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  return {
    ...(input.traceId ? { traceId: input.traceId } : {}),
    runtime: created.runtime,
    pi: created.pi,
  };
}

export function activeSessionLineageMatches(
  runtime: RuntimeSession,
  input: {
    parentSessionId?: string;
    childSessionId?: string;
    runId?: string;
    spawnBatchId?: string;
    taskRunId?: string;
  },
): boolean {
  return (
    runtime.parentSessionId === input.parentSessionId &&
    runtime.childSessionId === input.childSessionId &&
    runtime.runId === input.runId &&
    runtime.spawnBatchId === input.spawnBatchId &&
    runtime.taskRunId === input.taskRunId
  );
}

export function abortPiSession(pi: { abort?: () => Promise<unknown> }): void {
  void pi.abort?.().catch(() => undefined);
}

export function toTelemetryText(value: string, maxLength = 20_000): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
    : value;
}

export function isActiveSubagentStatus(status: SubagentRunStatus): boolean {
  return status === 'pending' || status === 'running';
}

export function summarizeSubagentToolResult(result: SpawnSubagentResult): JsonObject {
  if (result.status !== 'completed') {
    return {
      status: result.status,
      error: result.error,
    };
  }
  return {
    status: result.status,
    runId: result.run.runId,
    taskRunId: result.run.taskRunId ?? result.run.runId,
    ...(result.run.spawnBatchId ? { spawnBatchId: result.run.spawnBatchId } : {}),
    childSessionId: result.run.childSessionId,
    ...(result.run.agent ? { agent: result.run.agent } : {}),
    ...(result.run.label ? { label: result.run.label } : {}),
    task: toTelemetryText(result.run.task),
    result: toTelemetryText(result.result),
  };
}

export function defaultSubagentSpawnBatchId(request: RuntimeRequestContext): string {
  if (request.traceId) {
    return `trace:${request.traceId}`;
  }
  return `session:${request.sessionId}:${request.conversationId}`;
}

function assertSubagentToolAllowed(
  policy: SubagentPolicyEngine,
  request: RuntimeRequestContext,
  toolCallId: string,
  args: JsonObject,
): void {
  const decision = policy.decide({
    request,
    toolCall: {
      id: toolCallId,
      name: 'sessions_spawn',
      source: 'runtime',
      args,
    },
  });
  if (
    decision.kind === 'allow' ||
    decision.kind === 'allow_with_constraints' ||
    decision.kind === 'sandbox_only'
  ) {
    return;
  }
  if (decision.kind === 'ask') {
    throw new Error(`Tool call requires approval: ${decision.reason}`);
  }
  throw new Error(`Tool call denied by policy: ${decision.reason}`);
}

function mergeModel(
  base: RuntimeModelConfig,
  override: Partial<RuntimeModelConfig>,
): RuntimeModelConfig {
  const reasoning = override.reasoning ?? base.reasoning;
  const thinkingLevel = override.thinkingLevel ?? base.thinkingLevel;
  const authProfileId = override.authProfileId ?? base.authProfileId;
  return {
    provider: override.provider ?? base.provider,
    model: override.model ?? base.model,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(authProfileId ? { authProfileId } : {}),
  };
}

function parseModelRef(value: string, provider?: string): Partial<RuntimeModelConfig> {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('/');
  if (separator > 0) {
    return {
      provider: trimmed.slice(0, separator),
      model: trimmed.slice(separator + 1),
    };
  }
  return {
    ...(provider ? { provider } : {}),
    model: trimmed,
  };
}

function sameModel(a: RuntimeModelConfig, b: RuntimeModelConfig): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.reasoning === b.reasoning &&
    a.thinkingLevel === b.thinkingLevel &&
    a.authProfileId === b.authProfileId
  );
}

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }
  return { errorMessage: String(error) };
}
