import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { MemoryResult, MemoryStore, MemoryTarget } from './store.js';

const targetSchema = Type.Union([Type.Literal('memory'), Type.Literal('user')], {
  description: "Which memory store: 'memory' (your notes) or 'user' (user profile).",
});

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function jsonResult(
  value: MemoryResult | { entries: string[]; usage: string },
): AgentToolResult<unknown> {
  return textResult(JSON.stringify(value, null, 2));
}

function asTarget(raw: unknown): MemoryTarget {
  return raw === 'user' ? 'user' : 'memory';
}

const memoryToolDescription =
  'Save durable information to persistent memory that survives across sessions. ' +
  'Memory is injected into the system prompt at session start, so keep entries compact ' +
  'and focused on facts that will still matter later.\n\n' +
  'WHEN TO SAVE proactively:\n' +
  "- User corrects you or says 'remember this' / 'don't do that again'.\n" +
  '- User shares a preference, habit, or personal detail (name, role, timezone, coding style).\n' +
  '- You discover something stable about the environment (OS, installed tools, project structure).\n' +
  "- You learn a convention, API quirk, or workflow specific to this user's setup.\n\n" +
  'PRIORITY: User preferences and corrections > environment facts > procedural knowledge.\n\n' +
  'Do NOT save task progress, session outcomes, or temporary TODO state.\n\n' +
  "TARGETS: 'user' for who the user is; 'memory' for your own notes.";

export function createMemoryTools(store: MemoryStore): ToolDefinition[] {
  const addTool: ToolDefinition = {
    name: 'memory_add',
    label: 'Memory',
    description: `Append a new entry to memory. ${memoryToolDescription}`,
    promptSnippet: 'Append durable facts to MEMORY.md or USER.md.',
    parameters: Type.Object({
      target: targetSchema,
      content: Type.String({ description: 'The entry content to append.' }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const content = String(params.content ?? '');
      const result = await store.add(target, content);
      return jsonResult(result);
    },
  };

  const replaceTool: ToolDefinition = {
    name: 'memory_replace',
    label: 'Memory',
    description:
      'Replace an existing memory entry. Find the entry by short unique substring (oldText), ' +
      'replace it with newContent. Use this to update an outdated entry instead of removing + adding.',
    promptSnippet: 'Update an existing MEMORY.md or USER.md entry.',
    parameters: Type.Object({
      target: targetSchema,
      oldText: Type.String({
        description:
          'A short substring uniquely identifying the entry to replace. Must match exactly one entry.',
      }),
      newContent: Type.String({ description: 'The replacement entry content.' }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const oldText = String(params.oldText ?? '');
      const newContent = String(params.newContent ?? '');
      const result = await store.replace(target, oldText, newContent);
      return jsonResult(result);
    },
  };

  const removeTool: ToolDefinition = {
    name: 'memory_remove',
    label: 'Memory',
    description:
      'Remove a memory entry. Find the entry by short unique substring (oldText). ' +
      'Use this when an entry is no longer relevant or was wrong.',
    promptSnippet: 'Delete an entry from MEMORY.md or USER.md.',
    parameters: Type.Object({
      target: targetSchema,
      oldText: Type.String({
        description:
          'A short substring uniquely identifying the entry to remove. Must match exactly one entry.',
      }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const oldText = String(params.oldText ?? '');
      const result = await store.remove(target, oldText);
      return jsonResult(result);
    },
  };

  const readTool: ToolDefinition = {
    name: 'memory_read',
    label: 'Memory',
    description:
      'Return live entries and usage for a memory store. Use this to inspect what is currently saved ' +
      'before deciding to add, replace, or remove.',
    promptSnippet: 'Read the current contents of MEMORY.md or USER.md.',
    parameters: Type.Object({
      target: targetSchema,
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      const target = asTarget(params.target);
      const result = await store.read(target);
      return jsonResult(result);
    },
  };

  return [addTool, replaceTool, removeTool, readTool];
}
