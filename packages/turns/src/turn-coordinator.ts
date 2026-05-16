/**
 * Coordinates concurrent turn execution and per-session queueing.
 *
 * Owns global/session/subagent concurrency limits, busy strategies, queue
 * timeouts, and observable turn status. It does not execute chat logic itself.
 */
import type { JsonObject, RuntimeScope } from "@amaster.ai/pi-types";

export type SessionBusyStrategy = "reject" | "queue";
export type TurnSource = "chat" | "scheduled" | "subagent";
export type MaybePromise<T> = T | Promise<T>;

export type TurnCoordinatorOptions = {
  maxConcurrentTurns: number;
  maxConcurrentSubagents: number;
  maxQueuedTurns: number;
  maxQueuedTurnsPerSession: number;
  queueTimeoutMs: number;
  sessionBusyStrategy: SessionBusyStrategy;
};

export type TurnCoordinatorRunInput = {
  sessionId: string;
  source: TurnSource;
  busyStrategy?: SessionBusyStrategy;
  queueTimeoutMs?: number | null;
  tenantId: string;
  userId?: string;
  workspaceId?: string;
  turnId?: string;
};

export type TurnSessionInput = RuntimeScope & {
  sessionId: string;
};

export type TurnCancelInput = TurnSessionInput & {
  reason?: string;
};

export interface TurnCoordinatorLike {
  run<T>(input: TurnCoordinatorRunInput, task: () => Promise<T>): Promise<T>;
  cancelSession(input: TurnCancelInput): MaybePromise<number>;
  isSessionActive(input: TurnSessionInput): MaybePromise<boolean>;
  getSessionStatus(input: TurnSessionInput): MaybePromise<JsonObject>;
}

type TurnQueueEntry = {
  sessionId: string;
  source: TurnSource;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  timeout?: NodeJS.Timeout;
  started: boolean;
};

export class TurnCoordinatorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TurnCoordinatorError";
  }
}

export class SessionBusyError extends TurnCoordinatorError {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has a running or queued turn`, "session_busy", 409, 1000);
    this.name = "SessionBusyError";
  }
}

export class TurnQueueFullError extends TurnCoordinatorError {
  constructor() {
    super("Copilot turn queue is full", "turn_queue_full", 429, 1000);
    this.name = "TurnQueueFullError";
  }
}

export class TurnQueueTimeoutError extends TurnCoordinatorError {
  constructor(timeoutMs: number) {
    super(`Copilot turn waited in queue longer than ${timeoutMs}ms`, "turn_queue_timeout", 503, 1000);
    this.name = "TurnQueueTimeoutError";
  }
}

export class TurnCancelledError extends TurnCoordinatorError {
  constructor(sessionId: string, reason: string) {
    super(`Session ${sessionId} queued turn was cancelled: ${reason}`, "turn_cancelled", 409);
    this.name = "TurnCancelledError";
  }
}

export class TurnCoordinator implements TurnCoordinatorLike {
  private activeMainTurnCount = 0;
  private activeSubagentTurnCount = 0;
  private readonly activeSessions = new Set<string>();
  private readonly activeSources = new Map<string, TurnSource>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly queue: TurnQueueEntry[] = [];

  constructor(private readonly options: TurnCoordinatorOptions) {}

  run<T>(
    input: TurnCoordinatorRunInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const pendingForSession = this.pendingBySession.get(input.sessionId) ?? 0;
    const busyStrategy = input.busyStrategy ?? this.options.sessionBusyStrategy;
    if (pendingForSession > 0) {
      if (busyStrategy === "reject") {
        return Promise.reject(new SessionBusyError(input.sessionId));
      }
      const queuedForSession = pendingForSession - (this.activeSessions.has(input.sessionId) ? 1 : 0);
      if (queuedForSession >= this.options.maxQueuedTurnsPerSession) {
        return Promise.reject(new SessionBusyError(input.sessionId));
      }
    }

    const canStartNow = this.canStart(input.sessionId, input.source);
    if (!canStartNow && this.queue.length >= this.options.maxQueuedTurns) {
      return Promise.reject(new TurnQueueFullError());
    }

    this.incrementPending(input.sessionId);
    return new Promise<T>((resolve, reject) => {
      const entry: TurnQueueEntry = {
        sessionId: input.sessionId,
        source: input.source,
        task: () => task(),
        resolve: (value) => resolve(value as T),
        reject,
        enqueuedAt: Date.now(),
        started: false,
      };
      if (canStartNow) {
        this.start(entry);
        return;
      }
      const queueTimeoutMs = input.queueTimeoutMs === null
        ? undefined
        : input.queueTimeoutMs ?? this.options.queueTimeoutMs;
      if (queueTimeoutMs !== undefined) {
        entry.timeout = setTimeout(() => {
          if (entry.started) {
            return;
          }
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          this.decrementPending(entry.sessionId);
          reject(new TurnQueueTimeoutError(queueTimeoutMs));
        }, queueTimeoutMs);
        entry.timeout.unref();
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  cancelSession(input: TurnCancelInput): number {
    const reason = input.reason ?? "cancelled by request";
    let cancelled = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (!entry || entry.sessionId !== input.sessionId || entry.started) {
        continue;
      }
      this.queue.splice(index, 1);
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      this.decrementPending(entry.sessionId);
      entry.reject(new TurnCancelledError(input.sessionId, reason));
      cancelled += 1;
    }
    return cancelled;
  }

  isSessionActive(input: TurnSessionInput): boolean {
    return this.activeSessions.has(input.sessionId);
  }

  getSessionStatus(input: TurnSessionInput): JsonObject {
    const queued = this.queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.sessionId === input.sessionId && !entry.started)
      .map(({ entry, index }) => ({
        source: entry.source,
        queuePosition: index + 1,
        enqueuedAt: new Date(entry.enqueuedAt).toISOString(),
        waitMs: Math.max(0, Date.now() - entry.enqueuedAt),
      }));
    return {
      active: this.activeSessions.has(input.sessionId),
      activeSource: this.activeSources.get(input.sessionId),
      pendingCount: this.pendingBySession.get(input.sessionId) ?? 0,
      queuedCount: queued.length,
      queued,
    };
  }

  private canStart(sessionId: string, source: TurnSource): boolean {
    if (this.activeSessions.has(sessionId)) {
      return false;
    }
    return source === "subagent"
      ? this.activeSubagentTurnCount < this.options.maxConcurrentSubagents
      : this.activeMainTurnCount < this.options.maxConcurrentTurns;
  }

  private start(entry: TurnQueueEntry): void {
    entry.started = true;
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    if (entry.source === "subagent") {
      this.activeSubagentTurnCount += 1;
    } else {
      this.activeMainTurnCount += 1;
    }
    this.activeSessions.add(entry.sessionId);
    this.activeSources.set(entry.sessionId, entry.source);
    void (async () => {
      try {
        entry.resolve(await entry.task());
      } catch (error) {
        entry.reject(error);
      } finally {
        if (entry.source === "subagent") {
          this.activeSubagentTurnCount -= 1;
        } else {
          this.activeMainTurnCount -= 1;
        }
        this.activeSessions.delete(entry.sessionId);
        this.activeSources.delete(entry.sessionId);
        this.decrementPending(entry.sessionId);
        this.drain();
      }
    })();
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const index = this.queue.findIndex((entry) => this.canStart(entry.sessionId, entry.source));
      if (index < 0) {
        return;
      }
      const [entry] = this.queue.splice(index, 1);
      if (entry) {
        this.start(entry);
      }
    }
  }

  private incrementPending(sessionId: string): void {
    this.pendingBySession.set(sessionId, (this.pendingBySession.get(sessionId) ?? 0) + 1);
  }

  private decrementPending(sessionId: string): void {
    const next = (this.pendingBySession.get(sessionId) ?? 1) - 1;
    if (next <= 0) {
      this.pendingBySession.delete(sessionId);
    } else {
      this.pendingBySession.set(sessionId, next);
    }
  }
}
