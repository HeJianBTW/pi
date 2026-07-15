/**
 * Single-turn, tool-less LLM completion helper shared by the derive and
 * evaluate steps. Wraps pi-agent-core's Agent + pi-ai's streamSimple, the same
 * primitives pi-memory uses for background work.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { GoalModelConfig } from './config.js';

/** Minimal slice of ctx.modelRegistry we depend on (kept narrow for testability). */
export interface GoalModelRegistry {
  find(provider: string, model: string): unknown;
  getApiKeyAndHeaders(
    model: unknown,
  ): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface AgentMessageLike {
  role: string;
  content: unknown;
}

/**
 * Run one system+user prompt through the model and return the assistant's text.
 * Returns null on any resolution/auth failure so callers can degrade gracefully
 * (never throws for expected failures).
 */
export async function completeOnce(
  registry: GoalModelRegistry,
  modelConfig: GoalModelConfig,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const model = registry.find(modelConfig.provider, modelConfig.model);
  if (!model) return null;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) return null;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as never,
      tools: [] as never[],
    },
    streamFn: (m: unknown, c: unknown, streamOpts?: unknown) => {
      const merged = { ...((streamOpts as Record<string, unknown>) ?? {}) };
      if (auth.apiKey) merged.apiKey = auth.apiKey;
      if (auth.headers) merged.headers = auth.headers;
      const existingSignal = (streamOpts as { signal?: AbortSignal } | undefined)?.signal;
      if (!existingSignal && signal) merged.signal = signal;
      return streamSimple(m as never, c as never, merged as never);
    },
    convertToLlm: (msgs: unknown) => msgs as never[],
  });

  // Tool-less: a single assistant turn ends the run. Guard against runaway anyway.
  agent.subscribe((event: unknown) => {
    if ((event as { type?: string }).type === 'turn_end') {
      void agent.abort();
    }
  });

  try {
    await agent.prompt(userPrompt);
  } catch {
    return null;
  }

  return lastAssistantText(agent.state.messages as AgentMessageLike[]);
}

function lastAssistantText(messages: AgentMessageLike[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;
    const text = extractText(msg.content);
    if (text) return text;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}
