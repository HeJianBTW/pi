import { mkdir } from 'node:fs/promises';
import { SessionManager, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import {
  type ConsolidationModelRegistry,
  type DreamTurn,
  runConsolidation,
} from './consolidation.js';
import { readDreamingState, writeDreamingState } from './dreaming-state.js';

export interface DreamingConfig {
  enabled?: boolean;
  minHoursSinceLastRun?: number;
  minTurnsSinceLastRun?: number;
  /** @deprecated Use minTurnsSinceLastRun. */
  minSessionsSinceLastRun?: number;
  model?: { provider: string; model: string };
}

export interface RunDreamOptions {
  dreaming?: DreamingConfig;
  memoryDir: string;
  modelRegistry: ConsolidationModelRegistry;
  /** Current Pi session directory. */
  sessionDir?: string;
  /** Include sessions from every default Pi project directory. Default: false. */
  includeGlobalSessions?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_TURNS = 5;
const DEFAULT_MODEL = { provider: 'openai', model: 'gpt-4.1-mini' };

/** Run one gated memory-consolidation pass from the pi-memory extension. */
export async function runDream(options: RunDreamOptions): Promise<boolean> {
  const config = options.dreaming ?? {};
  if (config.enabled === false || options.signal?.aborted) return false;

  await mkdir(options.memoryDir, { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(options.memoryDir, { retries: 0, stale: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return false;
    throw error;
  }

  try {
    const state = await readDreamingState(options.memoryDir);
    const now = Date.now();
    const minHours = config.minHoursSinceLastRun ?? DEFAULT_MIN_HOURS;
    const minTurns =
      config.minTurnsSinceLastRun ?? config.minSessionsSinceLastRun ?? DEFAULT_MIN_TURNS;

    // Gate check: enough time since last run?
    if (state.lastConsolidatedAt) {
      const elapsed = now - new Date(state.lastConsolidatedAt).getTime();
      if (elapsed < minHours * 60 * 60 * 1000) return false;
    }

    // Gate check: enough Pi session turns since last run?
    const turns = await readPiSessionTurns(
      options.sessionDir,
      state.lastConsolidatedAt,
      options.includeGlobalSessions ?? false,
    );
    if (turns.length < minTurns || options.signal?.aborted) return false;

    // Consolidation
    let succeeded = false;
    try {
      succeeded = await runConsolidation({
        memoryDir: options.memoryDir,
        turns,
        modelConfig: config.model ?? DEFAULT_MODEL,
        modelRegistry: options.modelRegistry,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      console.error(
        `[pi-memory] consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!succeeded || options.signal?.aborted) return false;

    // Only update state if consolidation ran successfully
    await writeDreamingState(
      {
        ...state,
        lastConsolidatedAt: new Date(now).toISOString(),
        lastSessionCount: turns.length,
      },
      options.memoryDir,
    );
    return true;
  } finally {
    try {
      await release();
    } catch {
      // Lock was already released.
    }
  }
}

async function readPiSessionTurns(
  sessionDir: string | undefined,
  lastConsolidatedAt: string | null,
  includeGlobalSessions: boolean,
): Promise<DreamTurn[]> {
  const since = lastConsolidatedAt ? new Date(lastConsolidatedAt).getTime() : undefined;
  const sessionGroups = await Promise.all([
    ...(includeGlobalSessions ? [SessionManager.listAll()] : []),
    ...(sessionDir ? [SessionManager.listAll(sessionDir)] : []),
  ]);
  const sessions = [
    ...new Map(sessionGroups.flat().map((session) => [session.path, session])).values(),
  ];
  const turns = sessions.flatMap((session) => {
    if (since !== undefined && session.modified.getTime() <= since) return [];
    return sessionEntriesToTurns(SessionManager.open(session.path).getBranch(), session.id, since);
  });
  return turns.sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}

function sessionEntriesToTurns(
  entries: ReturnType<SessionManager['getBranch']>,
  sessionId: string,
  since: number | undefined,
): DreamTurn[] {
  const turns: DreamTurn[] = [];
  let pending:
    | {
        id: string;
        userMessage: string;
        assistantParts: string[];
        provider: string;
        model: string;
        completedAt: number;
      }
    | undefined;

  const flush = () => {
    if (!pending || pending.assistantParts.length === 0 || pending.completedAt <= (since ?? 0)) {
      pending = undefined;
      return;
    }
    turns.push({
      id: pending.id,
      sessionId,
      conversationId: sessionId,
      userMessage: pending.userMessage,
      assistantMessage: pending.assistantParts.join('\n'),
      model: { provider: pending.provider, model: pending.model },
      createdAt: new Date(pending.completedAt).toISOString(),
    });
    pending = undefined;
  };

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') {
      flush();
      pending = {
        id: entry.id,
        userMessage: messageText(entry),
        assistantParts: [],
        provider: 'unknown',
        model: 'unknown',
        completedAt: messageTimestamp(entry),
      };
    } else if (entry.message.role === 'assistant' && pending) {
      const text = messageText(entry);
      if (text) pending.assistantParts.push(text);
      pending.provider = entry.message.provider;
      pending.model = entry.message.model;
      pending.completedAt = messageTimestamp(entry);
    }
  }
  flush();
  return turns;
}

function messageText(entry: SessionMessageEntry): string {
  if (!('content' in entry.message)) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block && typeof block === 'object' && block.type === 'text' && 'text' in block),
    )
    .map((block) => block.text)
    .join('\n');
}

function messageTimestamp(entry: SessionMessageEntry): number {
  return typeof entry.message.timestamp === 'number'
    ? entry.message.timestamp
    : new Date(entry.timestamp).getTime();
}
