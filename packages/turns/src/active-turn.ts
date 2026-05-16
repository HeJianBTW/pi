/**
 * Handles requests that arrive while a chat session already has an active turn.
 *
 * Owns follow-up, steer, queue, and rejection behavior for in-flight sessions.
 * Keep first-turn execution, request parsing, and HTTP response wiring in the
 * surrounding chat route/service layers.
 */
import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  RuntimeLifecycleEvent,
  RuntimeModelConfig,
  RuntimeSession,
} from "@amaster.ai/pi-types";

export type ChatTurnMode = "reject" | "queue" | "steer" | "followup";
export type SubagentRoutingMode = "auto" | "off" | "force";

export type TurnLogger = {
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
};

export type TurnMetrics = {
  chatTurnsQueuedTotal: number;
};

export type ActiveTurnInput = {
  sessionId: string;
  conversationId: string;
  traceId: string;
  model: RuntimeModelConfig;
  turnMode?: ChatTurnMode;
  subagentMode: SubagentRoutingMode;
  requestedSkills: string[];
  message: string;
  originalMessage: string;
};

export type ActiveQueuedChatInput = {
  acceptedEventId: string;
  turnMode: Extract<ChatTurnMode, "steer" | "followup">;
  originalInput: string;
  injectedMessage: string;
  acceptedAt: string;
};

export type ActiveQueuedChatInputSummary = {
  eventId: string;
  acceptedEventId?: string;
  turnMode: Extract<ChatTurnMode, "steer" | "followup">;
  input: string;
  at: string;
};

export type QueueablePiSession = {
  steer?: (message: string) => unknown;
  followUp?: (message: string) => unknown;
  clearAllQueues?: () => unknown;
};

export type ActiveChatSession = {
  traceId?: string;
  runtime: RuntimeSession;
  pi: QueueablePiSession;
  extraToolResultBudget?: number;
  pendingQueuedInputs?: ActiveQueuedChatInput[];
  acceptedQueuedInputs?: ActiveQueuedChatInputSummary[];
};

type RuntimeLifecycleEventRecorder = (event: RuntimeLifecycleEvent) => Promise<void>;

export async function handleActiveChatTurn(input: {
  prepared: ActiveTurnInput;
  active: ActiveChatSession | undefined;
  sessionIsActive: boolean;
  maxToolResultsPerTurn: number;
  logger: TurnLogger;
  metrics: TurnMetrics;
  logFields: JsonObject;
  recordRuntimeEvent: RuntimeLifecycleEventRecorder;
  applySubagentRoutingGuidance: (
    message: string,
    options: {
      originalMessage: string;
      subagentMode: SubagentRoutingMode;
      canUseSubagent: boolean;
    },
  ) => { message: string; applied: boolean; reason?: string };
  toTelemetryText: (value: string) => string;
}): Promise<
  | { handled: false }
  | { handled: true; statusCode: number; eventName: "turn_failed" | "turn_queued"; payload: JsonObject }
> {
  const { prepared } = input;
  if (prepared.turnMode !== "steer" && prepared.turnMode !== "followup") {
    return { handled: false };
  }
  if (!input.sessionIsActive) {
    const error = `Session ${prepared.sessionId} has no active turn to ${prepared.turnMode}`;
    input.logger.warn("chat_turn_active_input_without_active_turn", {
      ...input.logFields,
      errorMessage: error,
    });
    return {
      handled: true,
      statusCode: 409,
      eventName: "turn_failed",
      payload: {
        sessionId: prepared.sessionId,
        traceId: prepared.traceId,
        conversationId: prepared.conversationId,
        model: prepared.model as RuntimeModelConfig,
        turnMode: prepared.turnMode,
        code: "no_active_turn",
        error,
        statusCode: 409,
      },
    };
  }
  const active = input.active;
  if (!active) {
    input.logger.warn("chat_turn_active_session_unavailable", input.logFields);
    return {
      handled: true,
      statusCode: 409,
      eventName: "turn_failed",
      payload: {
        sessionId: prepared.sessionId,
        traceId: prepared.traceId,
        conversationId: prepared.conversationId,
        model: prepared.model as RuntimeModelConfig,
        turnMode: prepared.turnMode,
        code: "active_session_unavailable",
        error: `Session ${prepared.sessionId} is running but its Pi session is unavailable`,
        statusCode: 409,
      },
    };
  }
  active.extraToolResultBudget = (active.extraToolResultBudget ?? 0) + input.maxToolResultsPerTurn;
  const injectedMessage = applyCopilotRuntimeGuidance(
    input.applySubagentRoutingGuidance(prepared.message, {
      originalMessage: prepared.originalMessage,
      subagentMode: prepared.subagentMode,
      canUseSubagent: false,
    }).message,
  );
  const activeTraceId = active.traceId ?? prepared.traceId;
  const acceptedEventId = randomUUID();
  const queuedInput: ActiveQueuedChatInput = {
    acceptedEventId,
    turnMode: prepared.turnMode,
    originalInput: prepared.originalMessage,
    injectedMessage,
    acceptedAt: new Date().toISOString(),
  };
  active.pendingQueuedInputs ??= [];
  active.pendingQueuedInputs.push(queuedInput);
  active.acceptedQueuedInputs ??= [];
  active.acceptedQueuedInputs.push({
    eventId: acceptedEventId,
    turnMode: prepared.turnMode,
    input: prepared.originalMessage,
    at: queuedInput.acceptedAt,
  });
  try {
    await enqueueActiveChatMessage(active.pi, prepared.turnMode, injectedMessage);
  } catch (error) {
    active.pendingQueuedInputs = active.pendingQueuedInputs.filter((entry) => entry !== queuedInput);
    input.logger.error("chat_turn_active_enqueue_failed", {
      ...input.logFields,
      activeTraceId,
      ...errorFields(error),
    });
    throw error;
  }
  await input.recordRuntimeEvent({
    id: acceptedEventId,
    traceId: activeTraceId,
    type: prepared.turnMode === "steer" ? "chat_turn_steered" : "chat_turn_followup_queued",
    sessionId: prepared.sessionId,
    conversationId: active.runtime.conversationId,
    createdAt: queuedInput.acceptedAt,
    model: active.runtime.model,
    toolPolicyProfile: active.runtime.toolPolicyProfile,
    details: {
      input: input.toTelemetryText(prepared.originalMessage),
      turnMode: prepared.turnMode,
      accepted: true,
      queuedIntoActiveTurn: true,
      acceptedEventId,
      ...(prepared.traceId !== activeTraceId ? { requestTraceId: prepared.traceId } : {}),
      ...(prepared.requestedSkills.length > 0 ? { requestedSkills: prepared.requestedSkills } : {}),
    },
  });
  const payload = {
    sessionId: prepared.sessionId,
    traceId: activeTraceId,
    conversationId: active.runtime.conversationId,
    model: active.runtime.model,
    turnMode: prepared.turnMode,
    accepted: true,
    queued: true,
    requestedSkills: prepared.requestedSkills,
  };
  input.logger.info("chat_turn_queued_into_active_turn", {
    ...input.logFields,
    activeTraceId,
    activeConversationId: active.runtime.conversationId,
    acceptedEventId,
  });
  input.metrics.chatTurnsQueuedTotal += 1;
  return {
    handled: true,
    statusCode: 202,
    eventName: "turn_queued",
    payload,
  };
}

export function clearPiQueues(pi: QueueablePiSession): void {
  void Promise.resolve(pi.clearAllQueues?.()).catch(() => undefined);
}

export async function enqueueActiveChatMessage(
  pi: QueueablePiSession,
  turnMode: Extract<ChatTurnMode, "steer" | "followup">,
  message: string,
): Promise<void> {
  if (turnMode === "steer") {
    if (typeof pi.steer !== "function") {
      throw new Error("Active Pi session does not support steer()");
    }
    await Promise.resolve(pi.steer(message));
    return;
  }
  if (typeof pi.followUp !== "function") {
    throw new Error("Active Pi session does not support followUp()");
  }
  await Promise.resolve(pi.followUp(message));
}

export function applyCopilotRuntimeGuidance(message: string): string {
  return [
    "Runtime guidance:",
    "- Do not print binary content, base64 blobs, or full generated artifacts in chat or tool output.",
    "- Do not inspect generated binary files with cat, base64, xxd, hexdump, or similar commands.",
    "- When you create a file, return the sandbox-relative file path and a short summary.",
    "- If an upload/export tool reports missing user, workspace, or auth context, stop retrying that tool and return the local sandbox path instead.",
    "",
    "User request:",
    message,
  ].join("\n");
}

function errorFields(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }
  return { errorMessage: String(error) };
}
