/**
 * JSON-file append stores for runtime observability events.
 *
 * Owns bounded persistence for tool calls, runtime lifecycle events, and model
 * generation events. Keep event construction, telemetry export, and live fan-out
 * in event-recorders.
 */
import type {
  AppendOnlyEventStore,
  JsonValue,
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
import { readJsonFile, writeJsonFile } from './json-file.js';

export class JsonFileRuntimeTimelineEventStore implements RuntimeTimelineEventStore {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxEvents: number,
  ) {}

  async append(event: RuntimeTimelineEventInput): Promise<void> {
    await this.enqueue(async () => {
      const events = await this.readAll();
      if (events.some((candidate) => candidate.eventId === event.eventId)) {
        return;
      }
      const sessionEvents = events.filter((candidate) => candidate.sessionId === event.sessionId);
      const eventSeq =
        sessionEvents.reduce((max, candidate) => Math.max(max, candidate.eventSeq), 0) + 1;
      events.push({ ...event, eventSeq });
      const retained = this.maxEvents > 0 ? events.slice(-this.maxEvents) : events;
      await writeJsonFile(this.filePath, retained);
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
    const filtered = events.filter(
      (event) =>
        (!input.sessionId ||
          event.sessionId === input.sessionId ||
          event.parentSessionId === input.sessionId ||
          event.childSessionId === input.sessionId) &&
        (!input.traceId || event.traceId === input.traceId) &&
        (input.afterSeq === undefined || event.eventSeq > input.afterSeq) &&
        (input.beforeSeq === undefined || event.eventSeq < input.beforeSeq) &&
        (!input.cursor || compareTimelineCursor(event, input.cursor) < 0),
    );
    const sorted = filtered.sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.eventId.localeCompare(right.eventId),
    );
    const limit = input.limit && input.limit > 0 ? input.limit : sorted.length;
    return sorted.slice(-limit);
  }

  private readAll(): Promise<RuntimeTimelineEvent[]> {
    return readJsonFile<RuntimeTimelineEvent[]>(this.filePath, []);
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

function compareTimelineCursor(event: RuntimeTimelineEvent, cursor: RuntimeTimelineCursor): number {
  const timeDiff = Date.parse(event.createdAt) - Date.parse(cursor.createdAt);
  return timeDiff || event.eventId.localeCompare(cursor.eventId);
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
