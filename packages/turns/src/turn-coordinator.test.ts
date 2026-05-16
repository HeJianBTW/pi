import { describe, expect, it } from "vitest";
import {
  SessionBusyError,
  TurnCancelledError,
  TurnCoordinator,
  TurnQueueTimeoutError,
} from "./turn-coordinator.js";

describe("TurnCoordinator", () => {
  it("rejects overlapping turns for the same session by default", async () => {
    const coordinator = createCoordinator();
    let releaseFirst: (() => void) | undefined;
    const firstStarted = deferred<void>();

    const first = coordinator.run({ tenantId: "tenant-1", sessionId: "session-1", source: "chat" }, async () => {
      firstStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    await firstStarted.promise;

    await expect(
      coordinator.run({ tenantId: "tenant-1", sessionId: "session-1", source: "chat" }, async () => "second"),
    ).rejects.toBeInstanceOf(SessionBusyError);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
  });

  it("queues same-session turns when requested", async () => {
    const coordinator = createCoordinator({ maxQueuedTurnsPerSession: 1 });
    let releaseFirst: (() => void) | undefined;
    const order: string[] = [];
    const firstStarted = deferred<void>();

    const first = coordinator.run({ tenantId: "tenant-1", sessionId: "session-1", source: "chat" }, async () => {
      order.push("first-start");
      firstStarted.resolve();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
      return "first";
    });
    await firstStarted.promise;

    const second = coordinator.run(
      { tenantId: "tenant-1", sessionId: "session-1", source: "chat", busyStrategy: "queue" },
      async () => {
        order.push("second");
        return "second";
      },
    );

    expect(coordinator.getSessionStatus({ tenantId: "tenant-1", sessionId: "session-1" })).toMatchObject({
      active: true,
      pendingCount: 2,
      queuedCount: 1,
    });

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("times out queued turns", async () => {
    const coordinator = createCoordinator({ queueTimeoutMs: 10 });
    const firstStarted = deferred<void>();

    void coordinator.run({ tenantId: "tenant-1", sessionId: "session-1", source: "chat" }, async () => {
      firstStarted.resolve();
      await new Promise(() => undefined);
    });
    await firstStarted.promise;

    await expect(
      coordinator.run(
        { tenantId: "tenant-1", sessionId: "session-1", source: "chat", busyStrategy: "queue" },
        async () => "queued",
      ),
    ).rejects.toBeInstanceOf(TurnQueueTimeoutError);
  });

  it("cancels queued turns for a session", async () => {
    const coordinator = createCoordinator({ maxQueuedTurnsPerSession: 1 });
    const firstStarted = deferred<void>();

    void coordinator.run({ tenantId: "tenant-1", sessionId: "session-1", source: "chat" }, async () => {
      firstStarted.resolve();
      await new Promise(() => undefined);
    });
    await firstStarted.promise;

    const queued = coordinator.run(
      { tenantId: "tenant-1", sessionId: "session-1", source: "chat", busyStrategy: "queue", queueTimeoutMs: null },
      async () => "queued",
    );
    expect(coordinator.cancelSession({ tenantId: "tenant-1", sessionId: "session-1", reason: "test cancel" })).toBe(1);
    await expect(queued).rejects.toBeInstanceOf(TurnCancelledError);
    expect(coordinator.getSessionStatus({ tenantId: "tenant-1", sessionId: "session-1" })).toMatchObject({
      pendingCount: 1,
      queuedCount: 0,
    });
  });

  it("tracks main and subagent concurrency separately", async () => {
    const coordinator = createCoordinator({
      maxConcurrentTurns: 1,
      maxConcurrentSubagents: 1,
      maxQueuedTurns: 4,
    });
    const order: string[] = [];
    const releaseMain = deferred<void>();
    const releaseSubagent = deferred<void>();
    const mainStarted = deferred<void>();
    const subagentStarted = deferred<void>();

    const main = coordinator.run({ tenantId: "tenant-1", sessionId: "main-1", source: "chat" }, async () => {
      order.push("main-1");
      mainStarted.resolve();
      await releaseMain.promise;
      return "main";
    });
    const subagent = coordinator.run({ tenantId: "tenant-1", sessionId: "subagent-1", source: "subagent" }, async () => {
      order.push("subagent-1");
      subagentStarted.resolve();
      await releaseSubagent.promise;
      return "subagent";
    });

    await Promise.all([mainStarted.promise, subagentStarted.promise]);
    const queuedMain = coordinator.run({ tenantId: "tenant-1", sessionId: "main-2", source: "chat" }, async () => {
      order.push("main-2");
      return "main-2";
    });
    const queuedSubagent = coordinator.run({ tenantId: "tenant-1", sessionId: "subagent-2", source: "subagent" }, async () => {
      order.push("subagent-2");
      return "subagent-2";
    });

    releaseMain.resolve();
    await expect(main).resolves.toBe("main");
    await expect(queuedMain).resolves.toBe("main-2");
    expect(order).toEqual(["main-1", "subagent-1", "main-2"]);

    releaseSubagent.resolve();
    await expect(subagent).resolves.toBe("subagent");
    await expect(queuedSubagent).resolves.toBe("subagent-2");
    expect(order).toEqual(["main-1", "subagent-1", "main-2", "subagent-2"]);
  });
});

function createCoordinator(options: Partial<ConstructorParameters<typeof TurnCoordinator>[0]> = {}): TurnCoordinator {
  return new TurnCoordinator({
    maxConcurrentTurns: 1,
    maxConcurrentSubagents: 1,
    maxQueuedTurns: 8,
    maxQueuedTurnsPerSession: 1,
    queueTimeoutMs: 1000,
    sessionBusyStrategy: "reject",
    ...options,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
