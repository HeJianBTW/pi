export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type RuntimeModelConfig = {
  provider: string;
  model: string;
  reasoning?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  authProfileId?: string;
};

export type RuntimeToolEventStatus = "started" | "completed" | "failed";

export type RuntimeToolEvent = {
  id: string;
  traceId?: string;
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  toolCallId: string;
  toolName: string;
  status: RuntimeToolEventStatus;
  createdAt: string;
  durationMs?: number;
  args?: JsonObject;
  details?: JsonObject;
  error?: string;
};

export type RuntimeLlmGenerationEventStatus = "started" | "completed" | "failed";

export type RuntimeLlmUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type RuntimeLlmGenerationEvent = {
  id: string;
  traceId?: string;
  sessionId: string;
  conversationId: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  llmGenerationId: string;
  status: RuntimeLlmGenerationEventStatus;
  createdAt: string;
  durationMs?: number;
  model: RuntimeModelConfig;
  input?: JsonValue;
  output?: JsonValue;
  usage?: RuntimeLlmUsage;
  responseId?: string;
  stopReason?: string;
  error?: string;
};

export type RuntimeLifecycleEventType =
  | "chat_turn_started"
  | "chat_turn_steered"
  | "chat_turn_steer_delivered"
  | "chat_turn_followup_queued"
  | "chat_turn_followup_delivered"
  | "chat_turn_completed"
  | "chat_turn_failed"
  | "subagent_spawned"
  | "subagent_started"
  | "subagent_completed"
  | "subagent_failed"
  | "subagent_cancelled";

export type RuntimeLifecycleEvent = {
  id: string;
  traceId?: string;
  type: RuntimeLifecycleEventType;
  sessionId: string;
  conversationId?: string;
  parentSessionId?: string;
  childSessionId?: string;
  runId?: string;
  spawnBatchId?: string;
  taskRunId?: string;
  parentToolCallId?: string;
  createdAt: string;
  durationMs?: number;
  model?: RuntimeModelConfig;
  toolPolicyProfile?: string;
  details?: JsonObject;
  error?: string;
};
