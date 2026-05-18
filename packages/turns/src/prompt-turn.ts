/**
 * Bridges a prepared chat turn into low-level Pi runtime prompting.
 *
 * Owns prompt timeout handling, tool result limits, runtime/model event
 * recording around the prompt call, and expected turn error types. Keep HTTP
 * routing and high-level response payload shaping in chat-turn-service.
 */
import { randomUUID } from 'node:crypto';
import type {
  JsonObject,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeModelConfig,
  RuntimeSession,
} from '@amaster.ai/pi-shared';
import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai';
import {
  type ActiveQueuedChatInput,
  type ActiveQueuedChatInputSummary,
  applyCopilotRuntimeGuidance,
} from './active-turn.js';

export type RuntimeLifecycleEventRecorder = (event: RuntimeLifecycleEvent) => Promise<void>;
export type RuntimeLlmGenerationEventRecorder = (event: RuntimeLlmGenerationEvent) => Promise<void>;
export type TurnStreamSink = (eventName: string, payload: JsonObject, eventId?: string) => void;

export type PromptChatSession = {
  traceId?: string;
  runtime: RuntimeSession;
  extraToolResultBudget?: number;
  pendingQueuedInputs?: ActiveQueuedChatInput[];
  deliveredQueuedInputs?: ActiveQueuedChatInputSummary[];
  pi: {
    messages: readonly unknown[];
    agent?: { state?: { systemPrompt?: unknown; tools?: unknown[] } };
    prompt: (
      message: string,
      options?: { expandPromptTemplates: boolean; source: 'rpc'; images?: ImageContent[] },
    ) => Promise<unknown>;
    abort?: () => Promise<unknown>;
    subscribe?: (listener: (event: RuntimeMessageEvent) => void) => () => void;
  };
};

type RuntimeMessageEvent = {
  type?: string;
  message?: unknown;
  assistantMessageEvent?: unknown;
};

export class ChatTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Chat turn timed out after ${timeoutMs}ms`);
    this.name = 'ChatTurnTimeoutError';
  }
}

export class ChatTurnToolLimitError extends Error {
  constructor(limit: number) {
    super(`Chat turn stopped after ${limit} tool results to prevent a runaway tool loop`);
    this.name = 'ChatTurnToolLimitError';
  }
}

export class ChatTurnCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChatTurnCancelledError';
  }
}

export async function promptChatTurn(
  active: PromptChatSession,
  message: string,
  timeoutMs: number,
  maxToolResults: number,
  images: ImageContent[] = [],
  telemetry?: {
    input: string;
    recordRuntimeEvent?: RuntimeLifecycleEventRecorder;
    recordLlmGenerationEvent: RuntimeLlmGenerationEventRecorder;
    stream?: TurnStreamSink;
    parentSessionId?: string;
    childSessionId?: string;
    runId?: string;
    spawnBatchId?: string;
    taskRunId?: string;
  },
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let guard: NodeJS.Timeout | undefined;
  const llmGenerationTelemetry = telemetry
    ? observeLlmGenerations(
        active,
        telemetry.input,
        telemetry.recordLlmGenerationEvent,
        telemetry.recordRuntimeEvent,
        telemetry.stream,
        {
          ...(telemetry.parentSessionId ? { parentSessionId: telemetry.parentSessionId } : {}),
          ...(telemetry.childSessionId ? { childSessionId: telemetry.childSessionId } : {}),
          ...(telemetry.runId ? { runId: telemetry.runId } : {}),
          ...(telemetry.spawnBatchId ? { spawnBatchId: telemetry.spawnBatchId } : {}),
          ...(telemetry.taskRunId ? { taskRunId: telemetry.taskRunId } : {}),
        },
      )
    : undefined;
  const initialToolResults = countToolResultMessages(active.pi.messages);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ChatTurnTimeoutError(timeoutMs)), timeoutMs);
    timer.unref();
  });
  const toolLimit = new Promise<never>((_resolve, reject) => {
    guard = setInterval(() => {
      const limit = currentToolResultLimit(active, maxToolResults);
      if (countToolResultMessages(active.pi.messages) - initialToolResults < limit) {
        return;
      }
      clearInterval(guard);
      abortPiSession(active.pi);
      reject(new ChatTurnToolLimitError(limit));
    }, 250);
    guard.unref();
  });
  try {
    await Promise.race([
      active.pi.prompt(applyCopilotRuntimeGuidance(message), {
        expandPromptTemplates: true,
        source: 'rpc',
        ...(images.length > 0 ? { images } : {}),
      }),
      timeout,
      toolLimit,
    ]);
    const limit = currentToolResultLimit(active, maxToolResults);
    if (countToolResultMessages(active.pi.messages) - initialToolResults >= limit) {
      abortPiSession(active.pi);
      throw new ChatTurnToolLimitError(limit);
    }
  } catch (error) {
    llmGenerationTelemetry?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    llmGenerationTelemetry?.unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
    if (guard) {
      clearInterval(guard);
    }
    await llmGenerationTelemetry?.settle();
  }
}

function observeLlmGenerations(
  active: PromptChatSession,
  input: string,
  recordLlmGenerationEvent: RuntimeLlmGenerationEventRecorder,
  recordRuntimeEvent?: RuntimeLifecycleEventRecorder,
  stream?: TurnStreamSink,
  lineage: {
    parentSessionId?: string;
    childSessionId?: string;
    runId?: string;
    spawnBatchId?: string;
    taskRunId?: string;
  } = {},
): { unsubscribe: () => void; fail: (reason: string) => void; settle: () => Promise<void> } {
  if (typeof active.pi.subscribe !== 'function') {
    return { unsubscribe: () => undefined, fail: () => undefined, settle: async () => undefined };
  }
  let llmGenerationIndex = 0;
  const pending: Array<Promise<void>> = [];
  let currentGeneration:
    | { startedAt: number; llmGenerationId: string; input: JsonObject | string }
    | undefined;
  const enqueue = (event: RuntimeLlmGenerationEvent): void => {
    pending.push(
      recordLlmGenerationEvent(event).catch((error) => {
        console.warn(
          `Model-call event recording failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  };
  const enqueueRuntime = (event: RuntimeLifecycleEvent): void => {
    if (!recordRuntimeEvent) {
      return;
    }
    pending.push(
      recordRuntimeEvent(event).catch((error) => {
        console.warn(
          `Runtime event recording failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    );
  };
  const unsubscribe = active.pi.subscribe((event) => {
    if (event.type === 'message_start') {
      const message = event.message as { role?: string; content?: unknown[] | string } | undefined;
      if (message?.role === 'user') {
        const delivered = takeDeliveredQueuedChatInput(active, extractMessageText(message));
        if (delivered) {
          const deliveredEventId = randomUUID();
          recordDeliveredQueuedInput(active, delivered, deliveredEventId);
          enqueueRuntime({
            id: deliveredEventId,
            ...(active.traceId ? { traceId: active.traceId } : {}),
            sessionId: active.runtime.sessionId,
            conversationId: active.runtime.conversationId,
            type:
              delivered.turnMode === 'steer'
                ? 'chat_turn_steer_delivered'
                : 'chat_turn_followup_delivered',
            createdAt: new Date().toISOString(),
            model: active.runtime.model,
            toolPolicyProfile: active.runtime.toolPolicyProfile,
            details: {
              input: toTelemetryText(delivered.originalInput),
              turnMode: delivered.turnMode,
              delivered: true,
              acceptedAt: delivered.acceptedAt,
              acceptedEventId: delivered.acceptedEventId,
            },
          });
        }
      }
    }
    if (event.type === 'message_update') {
      const assistantEvent = event.assistantMessageEvent;
      if (!assistantEvent || typeof assistantEvent !== 'object') {
        return;
      }
      const typedEvent = assistantEvent as { type?: unknown; delta?: unknown; content?: unknown };
      if (typedEvent.type === 'text_delta' && typeof typedEvent.delta === 'string') {
        stream?.('assistant_text_delta', {
          traceId: active.traceId,
          sessionId: active.runtime.sessionId,
          conversationId: active.runtime.conversationId,
          delta: typedEvent.delta,
        });
      } else if (typedEvent.type === 'thinking_delta' && typeof typedEvent.delta === 'string') {
        stream?.('assistant_thinking_delta', {
          traceId: active.traceId,
          sessionId: active.runtime.sessionId,
          conversationId: active.runtime.conversationId,
          delta: typedEvent.delta,
        });
      } else if (typedEvent.type === 'text_end' && typeof typedEvent.content === 'string') {
        stream?.('assistant_text_end', {
          traceId: active.traceId,
          sessionId: active.runtime.sessionId,
          conversationId: active.runtime.conversationId,
          content: typedEvent.content,
        });
      }
      return;
    }
    if (event.type !== 'message_start' && event.type !== 'message_end') {
      return;
    }
    const message = event.message as AssistantMessage | undefined;
    if (message?.role !== 'assistant') {
      return;
    }
    if (event.type === 'message_start') {
      const startedAt = Date.now();
      const index = llmGenerationIndex;
      llmGenerationIndex += 1;
      const llmGenerationId = `${active.runtime.sessionId}:${startedAt.toString(36)}:${index}`;
      const generationInput = buildLlmGenerationInput(active, input, index);
      currentGeneration = { startedAt, llmGenerationId, input: generationInput };
      enqueue({
        id: randomUUID(),
        ...(active.traceId ? { traceId: active.traceId } : {}),
        sessionId: active.runtime.sessionId,
        conversationId: active.runtime.conversationId,
        ...(active.runtime.tenantId ? { tenantId: active.runtime.tenantId } : {}),
        ...(active.runtime.userId ? { userId: active.runtime.userId } : {}),
        ...(active.runtime.workspaceId ? { workspaceId: active.runtime.workspaceId } : {}),
        ...lineage,
        llmGenerationId,
        status: 'started',
        createdAt: new Date(startedAt).toISOString(),
        model: active.runtime.model,
        input: generationInput,
      });
      return;
    }

    const generation =
      currentGeneration ?? createFallbackLlmGeneration(active, input, llmGenerationIndex++);
    currentGeneration = undefined;
    const completedAt = Date.now();
    const usage = normalizeAssistantUsage(message);
    enqueue({
      id: randomUUID(),
      ...(active.traceId ? { traceId: active.traceId } : {}),
      sessionId: active.runtime.sessionId,
      conversationId: active.runtime.conversationId,
      ...(active.runtime.tenantId ? { tenantId: active.runtime.tenantId } : {}),
      ...(active.runtime.userId ? { userId: active.runtime.userId } : {}),
      ...(active.runtime.workspaceId ? { workspaceId: active.runtime.workspaceId } : {}),
      ...lineage,
      llmGenerationId: generation.llmGenerationId,
      status: message.errorMessage ? 'failed' : 'completed',
      createdAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - generation.startedAt,
      model: active.runtime.model,
      input: generation.input,
      output: summarizeGenerationOutput(extractAssistantOutput(message)),
      ...(usage ? { usage } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      stopReason: message.stopReason,
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
    });
  });
  return {
    unsubscribe,
    fail: (reason: string) => {
      if (!currentGeneration) {
        return;
      }
      const failedAt = Date.now();
      const generation = currentGeneration;
      currentGeneration = undefined;
      enqueue({
        id: randomUUID(),
        ...(active.traceId ? { traceId: active.traceId } : {}),
        sessionId: active.runtime.sessionId,
        conversationId: active.runtime.conversationId,
        ...(active.runtime.tenantId ? { tenantId: active.runtime.tenantId } : {}),
        ...(active.runtime.userId ? { userId: active.runtime.userId } : {}),
        ...(active.runtime.workspaceId ? { workspaceId: active.runtime.workspaceId } : {}),
        ...lineage,
        llmGenerationId: generation.llmGenerationId,
        status: 'failed',
        createdAt: new Date(failedAt).toISOString(),
        durationMs: failedAt - generation.startedAt,
        model: active.runtime.model,
        input: generation.input,
        output: { error: reason },
        error: reason,
      });
    },
    settle: async () => {
      await Promise.allSettled(pending);
    },
  };
}

function createFallbackLlmGeneration(
  active: PromptChatSession,
  input: string,
  index: number,
): { startedAt: number; llmGenerationId: string; input: JsonObject | string } {
  const startedAt = Date.now();
  return {
    startedAt,
    llmGenerationId: `${active.runtime.sessionId}:${startedAt.toString(36)}:${index}`,
    input: buildLlmGenerationInput(active, input, index),
  };
}

function buildLlmGenerationInput(
  active: PromptChatSession,
  fallbackInput: string,
  llmGenerationIndex: number,
): JsonObject | string {
  const messages = llmInputMessagesSnapshot(active.pi.messages);
  const systemPrompt =
    typeof active.pi.agent?.state?.systemPrompt === 'string'
      ? active.pi.agent.state.systemPrompt
      : undefined;
  if (messages.length === 0 && !systemPrompt) {
    return llmGenerationIndex === 0
      ? fallbackInput
      : {
          continuation: true,
          llmGenerationIndex,
          previousToolResultCount: countToolResultMessages(active.pi.messages),
        };
  }
  return {
    ...(llmGenerationIndex > 0
      ? {
          continuation: true,
          llmGenerationIndex,
          previousToolResultCount: countToolResultMessages(active.pi.messages),
        }
      : {}),
    ...(systemPrompt ? { systemPrompt: toTelemetryText(systemPrompt, 40_000) } : {}),
    messages,
    ...(Array.isArray(active.pi.agent?.state?.tools)
      ? { toolCount: active.pi.agent.state.tools.length }
      : {}),
  };
}

function llmInputMessagesSnapshot(messages: readonly unknown[]): JsonObject[] {
  const candidates = [...messages];
  const last = candidates[candidates.length - 1] as { role?: string } | undefined;
  if (last?.role === 'assistant') {
    candidates.pop();
  }
  return candidates
    .map(formatLlmInputMessage)
    .filter((message): message is JsonObject => Boolean(message));
}

function formatLlmInputMessage(message: unknown): JsonObject | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const role = typeof message.role === 'string' ? message.role : undefined;
  if (!role) {
    return undefined;
  }
  return {
    role,
    ...(typeof message.customType === 'string' ? { customType: message.customType } : {}),
    ...(message.content !== undefined ? { content: summarizeLlmInputValue(message.content) } : {}),
    ...(typeof message.display === 'string'
      ? { display: toTelemetryText(message.display, 4_000) }
      : {}),
    ...(message.details !== undefined ? { details: summarizeLlmInputValue(message.details) } : {}),
  };
}

function summarizeLlmInputValue(value: unknown): JsonObject[string] {
  if (typeof value === 'string') {
    return toTelemetryText(value, 8_000);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeLlmInputValue(item)).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => {
        if (typeof raw === 'string' && /^(data|base64|bytes)$/i.test(key)) {
          return [key, `[omitted ${raw.length} chars]`];
        }
        return [key, summarizeLlmInputValue(raw)];
      }),
    ) as JsonObject;
  }
  return String(value);
}

function normalizeAssistantUsage(
  message: AssistantMessage,
): RuntimeLlmGenerationEvent['usage'] | undefined {
  const usage = message.usage;
  if (!usage) {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function extractAssistantOutput(message: AssistantMessage): string | JsonObject {
  const text = message.content.map((entry) => (entry.type === 'text' ? entry.text : '')).join('');
  const toolCalls = message.content
    .filter((entry) => entry.type === 'toolCall')
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      arguments: summarizeGenerationValue(entry.arguments),
    }));
  if (toolCalls.length === 0) {
    return text;
  }
  return {
    ...(text ? { text: toTelemetryText(text) } : {}),
    toolCalls,
  };
}

function summarizeGenerationOutput(value: string | JsonObject): string | JsonObject {
  return typeof value === 'string' ? toTelemetryText(value) : value;
}

function summarizeGenerationValue(value: unknown): JsonObject[string] {
  if (typeof value === 'string') {
    return toTelemetryText(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeGenerationValue(item)).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, raw]) => [key, summarizeGenerationValue(raw)]),
    ) as JsonObject;
  }
  return String(value);
}

function recordDeliveredQueuedInput(
  active: PromptChatSession,
  delivered: ActiveQueuedChatInput,
  deliveredEventId: string,
): void {
  active.deliveredQueuedInputs ??= [];
  active.deliveredQueuedInputs.push({
    eventId: deliveredEventId,
    acceptedEventId: delivered.acceptedEventId,
    turnMode: delivered.turnMode,
    input: delivered.originalInput,
    at: new Date().toISOString(),
  });
}

function takeDeliveredQueuedChatInput(
  active: PromptChatSession,
  messageText: string,
): ActiveQueuedChatInput | undefined {
  const pending = active.pendingQueuedInputs;
  if (!pending || pending.length === 0) {
    return undefined;
  }
  const index = pending.findIndex((entry) => entry.injectedMessage === messageText);
  if (index < 0) {
    return undefined;
  }
  const [entry] = pending.splice(index, 1);
  return entry;
}

export function countToolResultMessages(messages: readonly unknown[]): number {
  return messages.filter((message) => {
    const candidate = message as { role?: string } | undefined;
    return candidate?.role === 'toolResult';
  }).length;
}

function currentToolResultLimit(active: PromptChatSession, baseLimit: number): number {
  return baseLimit + Math.max(0, active.extraToolResultBudget ?? 0);
}

function abortPiSession(pi: PromptChatSession['pi']): void {
  void pi.abort?.().catch(() => undefined);
}

function extractMessageText(message: { content?: unknown[] | string }): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .map((entry) => {
      const content = entry as { type?: string; text?: string };
      return content.type === 'text' ? (content.text ?? '') : '';
    })
    .join('');
}

function toTelemetryText(value: string, maxLength = 20_000): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
