/**
 * JSON-file append stores for runtime observability events.
 *
 * Owns bounded persistence for tool calls, runtime lifecycle events, and model
 * generation events. Keep event construction, telemetry export, and live fan-out
 * in event-recorders.
 */
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
import { appendJsonlFile, readJsonFile, readJsonlFile, writeJsonFile } from './json-file.js';

/**
 * Stores timeline events in JSONL format (one JSON object per line).
 *
 * Append is O(1) regardless of file size — no read-modify-write cycle.
 */
export class JsonFileRuntimeTimelineEventStore implements RuntimeTimelineEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();
  private index:
    | {
        seqBySession: Map<string, number>;
        eventIds: Set<string>;
      }
    | undefined = undefined;

  constructor(private readonly filePath: string) {}

  async append(event: RuntimeTimelineEventInput): Promise<void> {
    await this.enqueue(async () => {
      const { seqBySession, eventIds } = await this.getIndex();
      if (eventIds.has(event.eventId)) {
        return;
      }
      const seqMap = seqBySession;
      const current = seqMap.get(event.sessionId) ?? 0;
      const eventSeq = current + 1;
      seqMap.set(event.sessionId, eventSeq);
      eventIds.add(event.eventId);
      await appendJsonlFile(this.filePath, { ...event, eventSeq });
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
    const events = await this.readAll();
    const cursorEvent = input.cursor
      ? events.find(
          (event) =>
            event.createdAt === input.cursor?.createdAt && event.eventId === input.cursor.eventId,
        )
      : undefined;
    const filtered = events.filter(
      (event) =>
        (!input.sessionId ||
          event.sessionId === input.sessionId ||
          event.parentSessionId === input.sessionId ||
          event.childSessionId === input.sessionId) &&
        (!input.traceId || event.traceId === input.traceId) &&
        (input.afterSeq === undefined || event.eventSeq > input.afterSeq) &&
        (input.beforeSeq === undefined || event.eventSeq < input.beforeSeq) &&
        (!input.cursor || compareTimelineCursor(event, input.cursor, cursorEvent) < 0),
    );
    const sorted = filtered.sort(compareTimelineEvents);
    const limit = input.limit && input.limit > 0 ? input.limit : sorted.length;
    return sorted.slice(-limit);
  }

  private async getIndex(): Promise<NonNullable<JsonFileRuntimeTimelineEventStore['index']>> {
    if (this.index === undefined) {
      const events = await this.readAll();
      const seqBySession = new Map<string, number>();
      const eventIds = new Set<string>();
      for (const e of events) {
        eventIds.add(e.eventId);
        const prev = seqBySession.get(e.sessionId) ?? 0;
        if (e.eventSeq > prev) seqBySession.set(e.sessionId, e.eventSeq);
      }
      this.index = { seqBySession, eventIds };
    }
    return this.index;
  }

  private async readAll(): Promise<RuntimeTimelineEvent[]> {
    return readJsonlFile<RuntimeTimelineEvent>(this.filePath);
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

function compareTimelineEvents(left: RuntimeTimelineEvent, right: RuntimeTimelineEvent): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.eventSeq - right.eventSeq ||
    left.eventId.localeCompare(right.eventId)
  );
}

function compareTimelineCursor(
  event: RuntimeTimelineEvent,
  cursor: RuntimeTimelineCursor,
  cursorEvent: RuntimeTimelineEvent | undefined,
): number {
  const timeDiff = Date.parse(event.createdAt) - Date.parse(cursor.createdAt);
  if (timeDiff) {
    return timeDiff;
  }
  if (cursorEvent) {
    const sequenceDiff = event.eventSeq - cursorEvent.eventSeq;
    if (sequenceDiff) {
      return sequenceDiff;
    }
  }
  return event.eventId.localeCompare(cursor.eventId);
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
