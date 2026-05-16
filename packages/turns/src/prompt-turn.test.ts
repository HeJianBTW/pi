import { describe, expect, it } from "vitest";
import type {
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeSession,
} from "@amaster.ai/pi-types";
import {
  ChatTurnTimeoutError,
  promptChatTurn,
  type PromptChatSession,
} from "./prompt-turn.js";

const model = { provider: "openai", model: "gpt-5", thinkingLevel: "medium" as const };

describe("promptChatTurn", () => {
  it("streams assistant deltas, records llm generations, and marks queued input delivery", async () => {
    let listener: ((event: { type?: string; message?: unknown; assistantMessageEvent?: unknown }) => void) | undefined;
    const streamEvents: Array<{ eventName: string; payload: unknown }> = [];
    const llmEvents: RuntimeLlmGenerationEvent[] = [];
    const runtimeEvents: RuntimeLifecycleEvent[] = [];
    const active: PromptChatSession = {
      traceId: "trace-1",
      runtime: runtimeSession(),
      pendingQueuedInputs: [
        {
          acceptedEventId: "accepted-1",
          turnMode: "followup",
          originalInput: "more detail",
          injectedMessage: "queued prompt",
          acceptedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
      pi: {
        messages: [{ role: "user", content: [{ type: "text", text: "initial prompt" }] }],
        prompt: async () => {
          listener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "queued prompt" }] } });
          listener?.({ type: "message_start", message: { role: "assistant", content: [] } });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "hello" } });
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
              usage: {
                input: 3,
                output: 4,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 7,
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
              },
              responseId: "response-1",
              stopReason: "end_turn",
            },
          });
        },
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    };

    await promptChatTurn(active, "hello", 1_000, 10, [], {
      input: "hello",
      recordRuntimeEvent: async (event) => {
        runtimeEvents.push(event);
      },
      recordLlmGenerationEvent: async (event) => {
        llmEvents.push(event);
      },
      stream: (eventName, payload) => {
        streamEvents.push({ eventName, payload });
      },
    });

    expect(runtimeEvents[0]).toMatchObject({
      type: "chat_turn_followup_delivered",
      details: expect.objectContaining({
        acceptedEventId: "accepted-1",
        delivered: true,
      }),
    });
    expect(active.pendingQueuedInputs).toHaveLength(0);
    expect(active.deliveredQueuedInputs?.[0]).toMatchObject({ acceptedEventId: "accepted-1", turnMode: "followup" });
    expect(streamEvents.map((event) => event.eventName)).toEqual([
      "assistant_thinking_delta",
      "assistant_text_delta",
      "assistant_text_end",
    ]);
    expect(llmEvents.map((event) => event.status)).toEqual(["started", "completed"]);
    expect(llmEvents[1]).toMatchObject({
      responseId: "response-1",
      stopReason: "end_turn",
      usage: expect.objectContaining({ totalTokens: 7 }),
    });
  });

  it("reports timeout errors", async () => {
    let aborted = false;
    const active: PromptChatSession = {
      runtime: runtimeSession(),
      pi: {
        messages: [],
        prompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        abort: async () => {
          aborted = true;
        },
      },
    };

    await expect(
      promptChatTurn(active, "slow", 1, 10, [], {
        input: "slow",
        recordLlmGenerationEvent: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ChatTurnTimeoutError);
    expect(aborted).toBe(false);
  });
});

function runtimeSession(): RuntimeSession {
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    tenantId: "tenant-1",
    model,
    sandboxStatus: "running",
    toolPolicyProfile: "sandbox-exec",
  };
}
