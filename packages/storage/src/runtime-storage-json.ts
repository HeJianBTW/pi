import path from 'node:path';
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
} from '@amaster.ai/pi-shared';
import { JsonFileArtifactStore } from './artifact-stores.js';
import {
  JsonFileLlmGenerationEventStore,
  JsonFileRuntimeEventStore,
  JsonFileRuntimeTimelineEventStore,
  JsonFileToolEventStore,
} from './event-stores.js';
import {
  JsonFileConversationStore,
  JsonFileMemoryStore,
  JsonFileTranscriptStore,
} from './session-stores.js';
import { JsonFileSubagentRunStore } from './subagent-store.js';

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

export function createJsonRuntimeStorage(
  agentDir: string,
  eventLimits: {
    runtimeEvents: number;
    toolEvents: number;
    llmGenerationEvents: number;
  },
): RuntimeStorageBundle {
  return {
    store: new JsonFileConversationStore(path.join(agentDir, 'sessions.json')),
    transcripts: new JsonFileTranscriptStore(path.join(agentDir, 'transcripts.json')),
    memory: new JsonFileMemoryStore(path.join(agentDir, 'memory.json')),
    runtimeEvents: new JsonFileRuntimeEventStore(
      path.join(agentDir, 'runtime-events.json'),
      eventLimits.runtimeEvents,
    ),
    toolEvents: new JsonFileToolEventStore(
      path.join(agentDir, 'tool-events.json'),
      eventLimits.toolEvents,
    ),
    llmGenerationEvents: new JsonFileLlmGenerationEventStore(
      path.join(agentDir, 'llm-generation-events.json'),
      eventLimits.llmGenerationEvents,
    ),
    timelineEvents: new JsonFileRuntimeTimelineEventStore(
      path.join(agentDir, 'events.json'),
      Math.max(eventLimits.runtimeEvents, eventLimits.toolEvents, eventLimits.llmGenerationEvents),
    ),
    subagents: new JsonFileSubagentRunStore(path.join(agentDir, 'subagents.json')),
    artifacts: new JsonFileArtifactStore(path.join(agentDir, 'artifacts.json')),
  };
}
