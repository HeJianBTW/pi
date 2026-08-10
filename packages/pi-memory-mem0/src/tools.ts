/**
 * LLM-callable tools for Mem0: search, profile (get all), and save (verbatim store).
 */

import { type AgentToolResult, truncateHead, truncateLine } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { formatRecalledMemory, redactMemoryText } from './privacy.js';
import type { Mem0Provider } from './provider.js';

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<AgentToolResult<unknown>>;
}

function textResult(text: string): AgentToolResult<unknown> {
  const result = truncateHead(text, { maxBytes: 47 * 1024, maxLines: 1_900 });
  const output = result.truncated
    ? JSON.stringify({
        truncated: true,
        preview: truncateLine(text, 4_000).text,
      })
    : result.content;
  return {
    content: [{ type: 'text' as const, text: output }],
    details: undefined,
  };
}

function rethrowIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Mem0 request cancelled.');
  }
}

export function createMem0Tools(provider: Mem0Provider, userId: string): ToolDefinition[] {
  const searchTool: ToolDefinition = {
    name: 'mem0_search',
    label: 'Mem0',
    description:
      'Search long-term memories by meaning. Returns relevant facts ranked by similarity.',
    promptSnippet: 'Semantic search over long-term user memories.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to search for.' }),
      top_k: Type.Optional(Type.Number({ description: 'Max results (default: 10, max: 50).' })),
    }),
    async execute(_toolCallId, params, signal) {
      const query = String(params.query ?? '');
      const topK = Math.min(Number(params.top_k) || 10, 50);

      if (!query) return textResult(JSON.stringify({ error: 'Query cannot be empty.' }));

      try {
        const results = await provider.search(query, {
          userId,
          topK,
          ...(signal ? { signal } : {}),
        });
        if (results.length === 0) {
          return textResult(JSON.stringify({ result: 'No relevant memories found.' }));
        }
        return textResult(
          JSON.stringify({
            results: results.map((r) => ({
              memory: formatRecalledMemory(r.memory),
              score: r.score,
            })),
            count: results.length,
          }),
        );
      } catch {
        rethrowIfCancelled(signal);
        throw new Error('Mem0 search failed.');
      }
    },
  };

  const profileTool: ToolDefinition = {
    name: 'mem0_profile',
    label: 'Mem0',
    description: 'Retrieve all stored long-term memories about the user.',
    promptSnippet: 'Full dump of all stored user memories.',
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      try {
        const memories = await provider.getAll({ userId, ...(signal ? { signal } : {}) });
        if (memories.length === 0) {
          return textResult(JSON.stringify({ result: 'No memories stored yet.' }));
        }
        const lines = memories
          .map((m) => m.memory)
          .filter(Boolean)
          .map(formatRecalledMemory);
        return textResult(JSON.stringify({ result: lines.join('\n'), count: lines.length }));
      } catch {
        rethrowIfCancelled(signal);
        throw new Error('Mem0 profile failed.');
      }
    },
  };

  const saveTool: ToolDefinition = {
    name: 'mem0_save',
    label: 'Mem0',
    description:
      'Store a durable fact about the user verbatim (no LLM extraction). Use for explicit preferences or corrections.',
    promptSnippet: 'Save a fact to long-term memory verbatim.',
    parameters: Type.Object({
      fact: Type.String({ description: 'The fact to store.' }),
    }),
    async execute(_toolCallId, params, signal) {
      const fact = String(params.fact ?? '').trim();
      if (!fact) return textResult(JSON.stringify({ error: 'Fact cannot be empty.' }));

      try {
        const result = await provider.add([{ role: 'user', content: redactMemoryText(fact) }], {
          userId,
          infer: false,
          ...(signal ? { signal } : {}),
        });
        return textResult(
          JSON.stringify(result ? { result: 'Fact stored.' } : { error: 'Failed to store.' }),
        );
      } catch {
        rethrowIfCancelled(signal);
        throw new Error('Mem0 save failed.');
      }
    },
  };

  return [searchTool, profileTool, saveTool];
}
