import { describe, expect, it } from 'vitest';
import {
  applySubagentRoutingGuidance,
  buildSubagentPrompt,
  createSubagentToolDefinitions,
  isActiveSubagentStatus,
  type RuntimeLifecycleEvent,
  type RuntimeRequestContext,
  resolveSubagentModel,
  resolveSubagentRole,
  type SubagentRegistry,
  type SubagentRun,
  type SubagentRunStore,
  spawnSubagentRun,
  summarizeSubagentToolResult,
} from './index.js';

const registry: SubagentRegistry = {
  roles: [
    {
      name: 'reviewer',
      description: 'Reviews code',
      filePath: '/tmp/reviewer.md',
      prompt: 'Focus on correctness and tests.',
      frontmatter: {},
    },
  ],
  byName: new Map(),
};
registry.byName.set('reviewer', registry.roles[0]!);
registry.byName.set('REVIEWER'.toLowerCase(), registry.roles[0]!);
const reviewer = registry.roles[0]!;

describe('subagents', () => {
  it('builds role-aware child prompts', () => {
    expect(
      buildSubagentPrompt({
        parentSessionId: 'parent-1',
        role: reviewer,
        label: 'api review',
        task: 'Check the task scheduler package.',
      }),
    ).toContain('Role instructions:\nFocus on correctness and tests.');
  });

  it('resolves model overrides without mutating missing fields', () => {
    expect(
      resolveSubagentModel(
        { provider: 'openai', model: 'gpt-5', thinkingLevel: 'medium' },
        { task: 'x', model: 'anthropic/claude', thinkingLevel: 'high' },
      ),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude',
      thinkingLevel: 'high',
    });
  });

  it('detects decomposable requests for routing guidance', () => {
    const result = applySubagentRoutingGuidance('build the app', {
      originalMessage: '实现一个后台系统，包含列表、详情、权限和数据 mock',
      subagentMode: 'auto',
      canUseSubagent: true,
    });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('multi-part-application-build');
  });

  it('resolves named roles case-insensitively', () => {
    expect(resolveSubagentRole(registry, 'REVIEWER')).toMatchObject({ name: 'reviewer' });
    expect(resolveSubagentRole(registry, 'missing')).toBe(
      'subagent role not found: missing. Available roles: reviewer',
    );
  });

  it('summarizes tool results and active statuses', () => {
    expect(isActiveSubagentStatus('pending')).toBe(true);
    expect(isActiveSubagentStatus('completed')).toBe(false);
    expect(summarizeSubagentToolResult({ status: 'error', error: 'bad task' })).toEqual({
      status: 'error',
      error: 'bad task',
    });
  });

  it('checks sessions_spawn against runtime policy source', async () => {
    const seenSources: string[] = [];
    const [tool] = createSubagentToolDefinitions({
      request: parentRequest(),
      getActive: () => undefined,
      policy: {
        decide: ({ toolCall }) => {
          seenSources.push(toolCall.source);
          return { kind: 'allow' };
        },
      },
      subagents: registry,
      parseThinkingLevel: () => 'medium',
      spawnSubagent: async (input, _active, parentToolCallId) => ({
        status: 'completed',
        result: 'done',
        run: {
          ...baseRun(),
          task: input.task,
          ...(parentToolCallId ? { parentToolCallId } : {}),
          status: 'completed',
          result: 'done',
        },
      }),
    });

    const result = await tool!.execute(
      'spawn-1',
      { task: 'review API', context: 'isolated' },
      new AbortController().signal,
      undefined,
      {} as never,
    );

    expect(seenSources).toEqual(['runtime']);
    expect(result.details).toMatchObject({ status: 'completed', result: 'done' });
  });

  it('spawns a child run through injected orchestration and inherits parent request semantics', async () => {
    const store = new MemorySubagentRunStore();
    const activeSessions = new Map();
    const createdRequests: RuntimeRequestContext[] = [];
    const recordedEvents: RuntimeLifecycleEvent[] = [];
    const transcripts: Array<{ sessionId: string; assistantMessage: string }> = [];
    const request = parentRequest({
      traceId: 'trace-1',
      trigger: 'cron',
      senderTrust: 'service',
      interactive: false,
    });

    const result = await spawnSubagentRun({
      request,
      input: { task: 'Check storage contracts', label: 'contract review' },
      defaultModel: request.model,
      runtime: {
        createOrResumeSession: async ({ request: childRequest, toolPolicyProfile }) => {
          createdRequests.push(childRequest);
          const messages: unknown[] = [];
          return {
            runtime: {
              sessionId: childRequest.sessionId,
              conversationId: childRequest.conversationId,
              tenantId: childRequest.tenantId,
              userId: childRequest.userId,
              workspaceId: childRequest.workspaceId,
              parentSessionId: childRequest.parentSessionId,
              childSessionId: childRequest.childSessionId,
              runId: childRequest.runId,
              spawnBatchId: childRequest.spawnBatchId,
              taskRunId: childRequest.taskRunId,
              model: childRequest.model,
              toolPolicyProfile,
            },
            pi: {
              messages,
              dispose: () => undefined,
            },
          };
        },
      },
      activeSessions,
      subagents: store,
      subagentRegistry: registry,
      turnCoordinator: {
        run: async (_input, handler) => handler(),
      },
      ensureRuntimeModelAvailable: () => undefined,
      limits: { maxDepth: 2, maxChildrenPerSession: 2, timeoutMs: 1_000 },
      chatTurnTimeoutMs: 1_000,
      maxSubagentToolResultsPerTurn: 4,
      transcripts: {
        appendTurn: async (turn) => {
          transcripts.push({ sessionId: turn.sessionId, assistantMessage: turn.assistantMessage });
        },
      },
      recordRuntimeEvent: async (event) => {
        recordedEvents.push(event);
      },
      recordLlmGenerationEvent: async () => undefined,
      logger: noopLogger,
      metrics: {
        subagentsSpawnedTotal: 0,
        subagentTurnsCompletedTotal: 0,
        subagentTurnsFailedTotal: 0,
        subagentsCancelledTotal: 0,
      },
      cancelChildSubagentsForParent: async () => 0,
      promptSubagentTurn: async (active) => {
        (active.pi.messages as unknown[]).push({
          role: 'assistant',
          content: [{ type: 'text', text: 'contract looks good' }],
        });
      },
      extractLastAssistant: () => ({ text: 'contract looks good' }),
    });

    expect(result).toMatchObject({ status: 'completed', result: 'contract looks good' });
    expect(createdRequests[0]).toMatchObject({
      trigger: 'cron',
      senderTrust: 'service',
      interactive: false,
      parentSessionId: 'parent-session',
      childSessionId: expect.stringMatching(/^parent-session:subagent:/),
    });
    expect(recordedEvents.map((event) => event.type)).toEqual([
      'subagent_spawned',
      'subagent_started',
      'subagent_completed',
    ]);
    expect(transcripts).toEqual([
      expect.objectContaining({
        sessionId: createdRequests[0]!.childSessionId,
        assistantMessage: 'contract looks good',
      }),
    ]);
    expect(activeSessions.size).toBe(0);
  });
});

function parentRequest(overrides: Partial<RuntimeRequestContext> = {}): RuntimeRequestContext {
  return {
    sessionId: 'parent-session',
    conversationId: 'parent-session',
    tenantId: 'tenant-1',
    userId: 'user-1',
    trigger: 'user',
    senderTrust: 'owner',
    interactive: true,
    model: { provider: 'openai', model: 'gpt-5', thinkingLevel: 'medium' },
    ...overrides,
  };
}

function baseRun(): SubagentRun {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    parentSessionId: 'parent-session',
    childSessionId: 'parent-session:subagent:child-1',
    task: 'task',
    status: 'pending',
    depth: 1,
    model: { provider: 'openai', model: 'gpt-5', thinkingLevel: 'medium' },
    toolPolicyProfile: 'subagent',
    context: 'isolated',
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
    events: [{ type: 'subagent_spawning', at: '2026-05-15T00:00:00.000Z' }],
  };
}

class MemorySubagentRunStore implements SubagentRunStore {
  private readonly runs = new Map<string, SubagentRun>();

  async create(input: Parameters<SubagentRunStore['create']>[0]): Promise<SubagentRun> {
    const run: SubagentRun = {
      runId: 'run-1',
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
      ...(input.spawnBatchId ? { spawnBatchId: input.spawnBatchId } : {}),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
      task: input.task,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.label ? { label: input.label } : {}),
      status: 'pending',
      depth: input.depth,
      model: input.model,
      toolPolicyProfile: input.toolPolicyProfile,
      context: input.context,
      createdAt: '2026-05-15T00:00:00.000Z',
      updatedAt: '2026-05-15T00:00:00.000Z',
      events: [{ type: 'subagent_spawning', at: '2026-05-15T00:00:00.000Z' }],
    };
    this.runs.set(run.runId, run);
    return run;
  }

  async list(
    _scope: Parameters<SubagentRunStore['list']>[0],
    parentSessionId?: string,
  ): Promise<SubagentRun[]> {
    return [...this.runs.values()].filter(
      (run) => !parentSessionId || run.parentSessionId === parentSessionId,
    );
  }

  async get(
    _scope: Parameters<SubagentRunStore['get']>[0],
    runId: string,
  ): Promise<SubagentRun | undefined> {
    return this.runs.get(runId);
  }

  async getDepthForSession(): Promise<number> {
    return 0;
  }

  async countActiveChildren(): Promise<number> {
    return 0;
  }

  async markRunning(
    _scope: Parameters<SubagentRunStore['markRunning']>[0],
    runId: string,
  ): Promise<SubagentRun | undefined> {
    return this.update(runId, {
      status: 'running',
      startedAt: '2026-05-15T00:00:01.000Z',
      events: [{ type: 'subagent_started', at: '2026-05-15T00:00:01.000Z' }],
    });
  }

  async markCompleted(
    _scope: Parameters<SubagentRunStore['markCompleted']>[0],
    runId: string,
    result: string,
  ): Promise<SubagentRun | undefined> {
    return this.update(runId, {
      status: 'completed',
      result,
      endedAt: '2026-05-15T00:00:02.000Z',
      events: [{ type: 'subagent_ended', reason: 'completed', at: '2026-05-15T00:00:02.000Z' }],
    });
  }

  async markFailed(
    _scope: Parameters<SubagentRunStore['markFailed']>[0],
    runId: string,
    error: string,
  ): Promise<SubagentRun | undefined> {
    return this.update(runId, {
      status: 'failed',
      error,
      endedAt: '2026-05-15T00:00:02.000Z',
      events: [{ type: 'subagent_ended', reason: 'failed', at: '2026-05-15T00:00:02.000Z' }],
    });
  }

  async markCancelled(
    _scope: Parameters<SubagentRunStore['markCancelled']>[0],
    runId: string,
    reason?: string,
  ): Promise<SubagentRun | undefined> {
    return this.update(runId, {
      status: 'cancelled',
      ...(reason ? { error: reason } : {}),
      endedAt: '2026-05-15T00:00:02.000Z',
      events: [{ type: 'subagent_ended', reason: 'cancelled', at: '2026-05-15T00:00:02.000Z' }],
    });
  }

  private update(
    runId: string,
    patch: Partial<SubagentRun> & { events?: SubagentRun['events'] },
  ): SubagentRun | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    const updated: SubagentRun = {
      ...run,
      ...patch,
      updatedAt: '2026-05-15T00:00:02.000Z',
      events: [...run.events, ...(patch.events ?? [])],
    };
    this.runs.set(runId, updated);
    return updated;
  }
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
