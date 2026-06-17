/**
 * JSON-file append stores for runtime observability events.
 *
 * Owns bounded persistence for tool calls, runtime lifecycle events, and model
 * generation events. Keep event construction, telemetry export, and live fan-out
 * in event-recorders.
 */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  LlmGenerationEventStore,
  RuntimeEventStore,
  RuntimeLifecycleEvent,
  RuntimeLlmGenerationEvent,
  RuntimeScope,
  RuntimeTimelineCursor,
  RuntimeTimelineEvent,
  RuntimeTimelineEventInput,
  RuntimeTimelineEventStore,
  RuntimeToolEvent,
  ToolEventStore,
} from '@amaster.ai/pi-shared';
import { appendJsonlFile, readJsonFile, writeJsonFile } from './json-file.js';

/**
 * Stores timeline events as session-sharded JSONL.
 *
 * Append stays O(1), and replay reads only the requested session shard with a
 * bounded in-memory page buffer instead of parsing the whole timeline.
 */
export class JsonFileRuntimeTimelineEventStore implements RuntimeTimelineEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();
  private indexes = new Map<string, RuntimeTimelineShardIndex>();

  constructor(private readonly directoryPath: string) {}

  async append(event: RuntimeTimelineEventInput): Promise<void> {
    await this.enqueue(async () => {
      const primaryIndex = await this.getShardIndex(event.sessionId);
      if (primaryIndex.eventIds.has(event.eventId)) {
        return;
      }
      const current = primaryIndex.seqBySession.get(event.sessionId) ?? 0;
      const eventSeq = current + 1;
      const storedEvent = { ...event, eventSeq };
      for (const shardId of shardIdsForTimelineEvent(storedEvent)) {
        const index = await this.getShardIndex(shardId);
        if (index.eventIds.has(event.eventId)) {
          continue;
        }
        index.eventIds.add(event.eventId);
        const shardSeq = index.seqBySession.get(event.sessionId) ?? 0;
        if (eventSeq > shardSeq) {
          index.seqBySession.set(event.sessionId, eventSeq);
        }
        await appendJsonlFile(this.shardPath(shardId), storedEvent);
      }
    });
  }

  async list(
    input: RuntimeScope & {
      sessionId?: string;
      traceId?: string;
      afterSeq?: number;
      beforeSeq?: number;
      cursor?: RuntimeTimelineCursor;
      limit?: number;
    },
  ): Promise<RuntimeTimelineEvent[]> {
    await this.writeTail.catch(() => undefined);
    const limit = input.limit && input.limit > 0 ? input.limit : Number.MAX_SAFE_INTEGER;
    if (input.sessionId) {
      return this.readShardPage(this.shardPath(input.sessionId), input, limit);
    }
    const byId = new Map<string, RuntimeTimelineEvent>();
    for (const shardPath of await this.listShardPaths()) {
      for (const event of await this.readShardPage(shardPath, input, limit)) {
        byId.set(event.eventId, event);
      }
    }
    return [...byId.values()].sort(compareTimelineEvents).slice(-limit);
  }

  private async getShardIndex(shardId: string): Promise<RuntimeTimelineShardIndex> {
    const cached = this.indexes.get(shardId);
    if (cached) {
      return cached;
    }
    const index = await this.buildShardIndex(this.shardPath(shardId));
    this.indexes.set(shardId, index);
    return index;
  }

  private async buildShardIndex(filePath: string): Promise<RuntimeTimelineShardIndex> {
    const index: RuntimeTimelineShardIndex = { seqBySession: new Map(), eventIds: new Set() };
    for await (const event of readJsonlEvents<RuntimeTimelineEvent>(filePath)) {
      index.eventIds.add(event.eventId);
      const prev = index.seqBySession.get(event.sessionId) ?? 0;
      if (event.eventSeq > prev) {
        index.seqBySession.set(event.sessionId, event.eventSeq);
      }
    }
    return index;
  }

  private async readShardPage(
    filePath: string,
    input: RuntimeScope & {
      sessionId?: string;
      traceId?: string;
      afterSeq?: number;
      beforeSeq?: number;
      cursor?: RuntimeTimelineCursor;
    },
    limit: number,
  ): Promise<RuntimeTimelineEvent[]> {
    const retained: RuntimeTimelineEvent[] = [];
    let cursorSeen = false;
    for await (const event of readJsonlEvents<RuntimeTimelineEvent>(filePath)) {
      const cursorResult = eventMatchesCursorWindow(event, input.cursor, cursorSeen);
      cursorSeen = cursorResult.cursorSeen;
      if (!matchesTimelineInput(event, input) || !cursorResult.include) {
        continue;
      }
      retained.push(event);
      if (retained.length > limit) {
        retained.shift();
      }
    }
    return retained;
  }

  private async listShardPaths(): Promise<string[]> {
    try {
      return (await readdir(this.directoryPath))
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => path.join(this.directoryPath, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private shardPath(shardId: string): string {
    return path.join(this.directoryPath, `${Buffer.from(shardId).toString('base64url')}.jsonl`);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

type RuntimeTimelineShardIndex = {
  seqBySession: Map<string, number>;
  eventIds: Set<string>;
};

function shardIdsForTimelineEvent(event: RuntimeTimelineEventInput): string[] {
  return [
    event.sessionId,
    event.conversationId,
    event.parentSessionId,
    event.childSessionId,
  ].filter(
    (value, index, values): value is string =>
      typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
  );
}

function matchesTimelineInput(
  event: RuntimeTimelineEvent,
  input: {
    sessionId?: string;
    traceId?: string;
    afterSeq?: number;
    beforeSeq?: number;
  },
): boolean {
  return (
    (!input.sessionId ||
      event.sessionId === input.sessionId ||
      event.conversationId === input.sessionId ||
      event.parentSessionId === input.sessionId ||
      event.childSessionId === input.sessionId) &&
    (!input.traceId || event.traceId === input.traceId) &&
    (input.afterSeq === undefined || event.eventSeq > input.afterSeq) &&
    (input.beforeSeq === undefined || event.eventSeq < input.beforeSeq)
  );
}

function eventMatchesCursorWindow(
  event: RuntimeTimelineEvent,
  cursor: RuntimeTimelineCursor | undefined,
  cursorSeen: boolean,
): { include: boolean; cursorSeen: boolean } {
  if (!cursor) {
    return { include: true, cursorSeen };
  }
  const timeDiff = Date.parse(event.createdAt) - Date.parse(cursor.createdAt);
  if (timeDiff) {
    return { include: timeDiff < 0, cursorSeen };
  }
  if (cursor.eventSeq !== undefined) {
    const seqDiff = event.eventSeq - cursor.eventSeq;
    if (seqDiff) {
      return { include: seqDiff < 0, cursorSeen };
    }
    return { include: event.eventId < cursor.eventId, cursorSeen };
  }
  if (event.eventId === cursor.eventId) {
    return { include: false, cursorSeen: true };
  }
  return { include: !cursorSeen, cursorSeen };
}

async function* readJsonlEvents<T>(filePath: string): AsyncGenerator<T> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield JSON.parse(trimmed) as T;
      } catch {
        // Skip malformed JSONL rows. A later append can still be read.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

function compareTimelineEvents(left: RuntimeTimelineEvent, right: RuntimeTimelineEvent): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.eventSeq - right.eventSeq ||
    left.eventId.localeCompare(right.eventId)
  );
}

export class JsonFileToolEventStore implements ToolEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEvents: number,
  ) {}

  async append(event: RuntimeToolEvent): Promise<void> {
    await this.enqueue(async () => {
      const events = await this.readAll();
      events.push(event);
      const retained = this.maxEvents > 0 ? events.slice(-this.maxEvents) : events;
      await writeJsonFile(this.filePath, retained);
    });
  }

  async list(
    input: { sessionId?: string; traceId?: string; limit?: number } = {},
  ): Promise<RuntimeToolEvent[]> {
    await this.writeTail.catch(() => undefined);
    const events = await this.readAll();
    const filtered = events.filter(
      (event) =>
        (!input.sessionId ||
          event.sessionId === input.sessionId ||
          event.parentSessionId === input.sessionId ||
          event.childSessionId === input.sessionId) &&
        (!input.traceId || event.traceId === input.traceId),
    );
    const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
    return filtered.slice(-limit);
  }

  private readAll(): Promise<RuntimeToolEvent[]> {
    return readJsonFile<RuntimeToolEvent[]>(this.filePath, []);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class JsonFileRuntimeEventStore implements RuntimeEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEvents: number,
  ) {}

  async append(event: RuntimeLifecycleEvent): Promise<void> {
    await this.enqueue(async () => {
      const events = await this.readAll();
      events.push(event);
      const retained = this.maxEvents > 0 ? events.slice(-this.maxEvents) : events;
      await writeJsonFile(this.filePath, retained);
    });
  }

  async list(
    input: { sessionId?: string; traceId?: string; type?: string; limit?: number } = {},
  ): Promise<RuntimeLifecycleEvent[]> {
    await this.writeTail.catch(() => undefined);
    const events = await this.readAll();
    const filtered = events.filter(
      (event) =>
        (!input.sessionId ||
          event.sessionId === input.sessionId ||
          event.parentSessionId === input.sessionId ||
          event.childSessionId === input.sessionId) &&
        (!input.traceId || event.traceId === input.traceId) &&
        (!input.type || event.type === input.type),
    );
    const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
    return filtered.slice(-limit);
  }

  private readAll(): Promise<RuntimeLifecycleEvent[]> {
    return readJsonFile<RuntimeLifecycleEvent[]>(this.filePath, []);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class JsonFileLlmGenerationEventStore implements LlmGenerationEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEvents: number,
  ) {}

  async append(event: RuntimeLlmGenerationEvent): Promise<void> {
    await this.enqueue(async () => {
      const events = await this.readAll();
      events.push(event);
      const retained = this.maxEvents > 0 ? events.slice(-this.maxEvents) : events;
      await writeJsonFile(this.filePath, retained);
    });
  }

  async list(
    input: { sessionId?: string; traceId?: string; limit?: number } = {},
  ): Promise<RuntimeLlmGenerationEvent[]> {
    await this.writeTail.catch(() => undefined);
    const events = await this.readAll();
    const filtered = events.filter(
      (event) =>
        (!input.sessionId ||
          event.sessionId === input.sessionId ||
          event.parentSessionId === input.sessionId ||
          event.childSessionId === input.sessionId) &&
        (!input.traceId || event.traceId === input.traceId),
    );
    const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
    return filtered.slice(-limit);
  }

  private readAll(): Promise<RuntimeLlmGenerationEvent[]> {
    return readJsonFile<RuntimeLlmGenerationEvent[]>(this.filePath, []);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release: () => void = () => undefined;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
