/**
 * Memory consolidation logic — agentic review of recent conversations.
 *
 * Spawns a pi-agent-core Agent with memory tools to review transcripts and
 * update entries. Follows a 4-phase prompt: Orient → Gather → Consolidate → Prune.
 */

import type { ConversationTurn } from '@amaster.ai/pi-shared';
import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const MAX_CONSOLIDATION_TURNS = 8;

export interface ConsolidationModelRegistry {
  find(provider: string, model: string): unknown;
  getApiKeyAndHeaders(
    model: unknown,
  ): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export interface ConsolidationOptions {
  memoryDir: string;
  turns: ConversationTurn[];
  modelConfig: { provider: string; model: string };
  modelRegistry: ConsolidationModelRegistry;
  signal?: AbortSignal;
  maxTurns?: number;
}

export const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation assistant performing a "dream" — a reflective pass over recent conversations to synthesize durable knowledge into long-term memory.

You have access to memory tools:
- memory_read: Read current memory entries (targets: "memory" for agent notes, "user" for user profile)
- memory_add: Add a new entry to a target
- memory_replace: Update an existing entry by substring match
- memory_remove: Remove an outdated or redundant entry

## Phase 1 — Orient

- Call memory_read for both "memory" and "user" targets to see what is currently stored.
- Understand the existing structure so you can merge into it rather than duplicating.
- Note entries that look stale, overly verbose, or contradicted by recent context.

## Phase 2 — Gather recent signal

Review the conversation transcripts provided. Look for:
1. New durable facts worth remembering (user preferences, project decisions, recurring patterns)
2. Information that contradicts or updates existing memory entries
3. Context that existing memories reference but got wrong

Don't try to capture everything. Focus on what a future session would benefit from knowing.

## Phase 3 — Consolidate

Make targeted updates using the memory tools:
- Use memory_replace to update stale entries with current information
- Use memory_add only for genuinely new facts not already captured
- Use memory_remove for entries that are clearly wrong, redundant, or superseded
- When multiple entries cover related facts, merge them into one via memory_replace

Important:
- Convert relative dates ("yesterday", "last week") to absolute dates
- Merge related entries rather than keeping fragments — one complete entry is better than three partial ones
- Keep entries terse and third-person

## Phase 4 — Prune

After consolidating, check capacity:
- The "memory" target has a ~2200 character limit
- The "user" target has a ~1375 character limit
- If approaching limits, compress verbose entries (remove filler words, combine related points)
- Remove entries that are subsumed by more complete ones

## Constraints

- ZERO information loss: every distinct, correct fact must survive unless clearly superseded
- Don't add trivial or ephemeral information (greetings, debugging steps, temporary state)
- Don't duplicate what is already stored — always check first via memory_read
- Focus on: user identity, preferences, project decisions, recurring patterns, important context
- If nothing meaningful has changed, say so — don't make changes for the sake of it
`;

export function buildConsolidationUserPrompt(turns: ConversationTurn[]): string {
  if (turns.length === 0) {
    return 'No recent conversations to review. Call memory_read to check current state and verify everything is still accurate.';
  }

  const maxChars = 8000;
  const header =
    '## Recent Conversations\n\nBelow are recent conversation turns (newest last). Review them for signal worth persisting.\n\n';
  const footer =
    '\n---\nBegin by calling memory_read for both targets to orient yourself, then consolidate as needed.';

  let totalChars = header.length + footer.length;
  const selected: string[] = [];

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const entry = `### Session ${turn.sessionId} (${turn.createdAt})\n**User:** ${turn.userMessage}\n**Assistant:** ${turn.assistantMessage}\n\n`;
    if (totalChars + entry.length > maxChars) break;
    selected.unshift(entry);
    totalChars += entry.length;
  }

  return header + selected.join('') + footer;
}

export async function runConsolidation(opts: ConsolidationOptions): Promise<boolean> {
  const { memoryDir, turns, modelConfig, modelRegistry, signal, maxTurns } = opts;

  const model = modelRegistry.find(modelConfig.provider, modelConfig.model);
  if (!model) return false;

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return false;

  const store = new MemoryStore({ dir: memoryDir });
  await store.loadFromDisk();

  const tools = createMemoryTools(store);
  const userPrompt = buildConsolidationUserPrompt(turns);

  const agent = new Agent({
    initialState: {
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      model: model as never,
      tools: tools as never[],
    },
    streamFn: (m, c, streamOpts) => {
      const existingSignal = (streamOpts as { signal?: AbortSignal } | undefined)?.signal;
      return streamSimple(m, c, {
        ...streamOpts,
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(existingSignal ? { signal: existingSignal } : signal ? { signal } : {}),
      });
    },
    convertToLlm: (msgs) => msgs as never[],
  });

  const limit = maxTurns ?? MAX_CONSOLIDATION_TURNS;
  let turnCount = 0;
  agent.subscribe((event) => {
    if (event.type === 'turn_end') {
      turnCount++;
      if (turnCount >= limit || signal?.aborted) {
        void agent.abort();
      }
    }
  });

  await agent.prompt(userPrompt);
  return true;
}
