/**
 * Runtime storage adapter factory.
 *
 * Owns the concrete store selection for local JSON and platform DB modes. Route
 * and runtime code depend on store interfaces only.
 */
import path from "node:path";
import {
  JsonFileLlmGenerationEventStore,
  JsonFileRuntimeEventStore,
  JsonFileRuntimeTimelineEventStore,
  JsonFileToolEventStore,
} from "./event-stores.js";
import {
  JsonFileConversationStore,
  JsonFileMemoryStore,
  JsonFileTranscriptStore,
} from "./session-stores.js";
import { JsonFileSubagentRunStore } from "./subagent-store.js";
import { createDbRuntimeStores, verifyDbRuntimeSchema } from "./db-runtime-storage.js";
import { JsonFileArtifactStore } from "./artifact-stores.js";
import { RedisLockManager } from "./redis-locks.js";
import type {
  CopilotMemoryStore,
  LlmGenerationEventStore,
  RuntimeArtifactStore,
  RuntimeEventStore,
  RuntimeSessionStore,
  RuntimeTimelineEventStore,
  SubagentRunStore,
  ToolEventStore,
  TranscriptStore,
} from "@amaster.ai/pi-types";

export type RuntimeStorageMode = "json" | "db";

export type RuntimeStorageBundle = {
  store: RuntimeSessionStore;
  transcripts: TranscriptStore;
  memory: CopilotMemoryStore;
  runtimeEvents: RuntimeEventStore;
  toolEvents: ToolEventStore;
  llmGenerationEvents: LlmGenerationEventStore;
  timelineEvents: RuntimeTimelineEventStore;
  subagents: SubagentRunStore;
  artifacts: RuntimeArtifactStore;
};

export function createRuntimeStorage(input: {
  mode: RuntimeStorageMode;
  agentDir: string;
  databaseUrl?: string | undefined;
  redisUrl?: string | undefined;
  eventLimits: {
    runtimeEvents: number;
    toolEvents: number;
    llmGenerationEvents: number;
  };
}): RuntimeStorageBundle {
  if (input.mode === "db") {
    assertDatabaseStorageConfigured(input.databaseUrl);
    assertRedisStorageConfigured(input.redisUrl);
    return createDbRuntimeStores(input.databaseUrl, input.redisUrl);
  }
  return createJsonRuntimeStorage(input.agentDir, input.eventLimits);
}

export async function verifyRuntimeStorage(input: {
  mode: RuntimeStorageMode;
  databaseUrl?: string | undefined;
  redisUrl?: string | undefined;
}): Promise<void> {
  if (input.mode !== "db") {
    return;
  }
  assertDatabaseStorageConfigured(input.databaseUrl);
  assertRedisStorageConfigured(input.redisUrl);
  await verifyDbRuntimeSchema(input.databaseUrl);
  const locks = new RedisLockManager(input.redisUrl);
  try {
    await locks.ping();
  } finally {
    await locks.disconnect();
  }
}

function createJsonRuntimeStorage(
  agentDir: string,
  eventLimits: {
    runtimeEvents: number;
    toolEvents: number;
    llmGenerationEvents: number;
  },
): RuntimeStorageBundle {
  return {
    store: new JsonFileConversationStore(path.join(agentDir, "sessions.json")),
    transcripts: new JsonFileTranscriptStore(path.join(agentDir, "transcripts.json")),
    memory: new JsonFileMemoryStore(path.join(agentDir, "memory.json")),
    runtimeEvents: new JsonFileRuntimeEventStore(
      path.join(agentDir, "runtime-events.json"),
      eventLimits.runtimeEvents,
    ),
    toolEvents: new JsonFileToolEventStore(
      path.join(agentDir, "tool-events.json"),
      eventLimits.toolEvents,
    ),
    llmGenerationEvents: new JsonFileLlmGenerationEventStore(
      path.join(agentDir, "llm-generation-events.json"),
      eventLimits.llmGenerationEvents,
    ),
    timelineEvents: new JsonFileRuntimeTimelineEventStore(
      path.join(agentDir, "events.json"),
      Math.max(eventLimits.runtimeEvents, eventLimits.toolEvents, eventLimits.llmGenerationEvents),
    ),
    subagents: new JsonFileSubagentRunStore(path.join(agentDir, "subagents.json")),
    artifacts: new JsonFileArtifactStore(path.join(agentDir, "artifacts.json")),
  };
}

function assertDatabaseStorageConfigured(databaseUrl: string | undefined): asserts databaseUrl is string {
  if (!databaseUrl) {
    throw new Error("STORAGE_MODE=db requires DATABASE_URL.");
  }
}

function assertRedisStorageConfigured(redisUrl: string | undefined): asserts redisUrl is string {
  if (!redisUrl) {
    throw new Error("STORAGE_MODE=db requires REDIS_URL.");
  }
}
