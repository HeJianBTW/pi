import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeStorage, verifyRuntimeStorage } from "./runtime-storage.js";

const tmpDirs: string[] = [];

describe("createRuntimeStorage", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates local JSON stores by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-storage-"));
    tmpDirs.push(dir);

    const storage = createRuntimeStorage({
      mode: "json",
      agentDir: dir,
      eventLimits: { runtimeEvents: 10, toolEvents: 10, llmGenerationEvents: 10 },
    });

    await expect(storage.store.listRuntimeSessions({ tenantId: "tenant-1" })).resolves.toEqual([]);
    await expect(storage.transcripts.listTurns({ tenantId: "tenant-1" })).resolves.toEqual([]);
    await expect(storage.timelineEvents.list({ tenantId: "tenant-1" })).resolves.toEqual([]);
    const artifact = await storage.artifacts.create({
      tenantId: "tenant-1",
      sessionId: "session-1",
      artifactType: "text",
      storageUri: "file:///tmp/output.txt",
      name: "output.txt",
    });
    await expect(storage.artifacts.get({ tenantId: "tenant-1" }, artifact.id)).resolves.toEqual(artifact);
    await expect(storage.artifacts.list({ tenantId: "tenant-1", sessionId: "session-1" })).resolves.toEqual([artifact]);
  });

  it("fails fast when db mode is configured without a database url", () => {
    expect(() =>
      createRuntimeStorage({
        mode: "db",
        agentDir: "/tmp/pi-storage",
        eventLimits: { runtimeEvents: 10, toolEvents: 10, llmGenerationEvents: 10 },
      })
    ).toThrow("STORAGE_MODE=db requires DATABASE_URL");
  });

  it("fails fast when db mode is configured without a redis url", () => {
    expect(() =>
      createRuntimeStorage({
        mode: "db",
        agentDir: "/tmp/pi-storage",
        databaseUrl: "mysql://user:pass@example.test/pi_agent",
        eventLimits: { runtimeEvents: 10, toolEvents: 10, llmGenerationEvents: 10 },
      })
    ).toThrow("STORAGE_MODE=db requires REDIS_URL");
  });

  it("creates DB stores when db mode has database and redis urls", () => {
    const storage = createRuntimeStorage({
      mode: "db",
      agentDir: "/tmp/pi-storage",
      databaseUrl: "mysql://user:pass@example.test/pi_agent",
      redisUrl: "redis://example.test:6379",
      eventLimits: { runtimeEvents: 10, toolEvents: 10, llmGenerationEvents: 10 },
    });

    expect(storage.store).toBeDefined();
    expect(storage.transcripts).toBeDefined();
    expect(storage.timelineEvents).toBeDefined();
    expect(storage.artifacts).toBeDefined();
  });

  it("skips readiness checks for JSON storage", async () => {
    await expect(verifyRuntimeStorage({ mode: "json" })).resolves.toBeUndefined();
  });

  it("fails readiness checks when db mode is missing a database url", async () => {
    await expect(verifyRuntimeStorage({ mode: "db" })).rejects.toThrow(
      "STORAGE_MODE=db requires DATABASE_URL",
    );
  });

  it("fails readiness checks when db mode is missing a redis url", async () => {
    await expect(verifyRuntimeStorage({
      mode: "db",
      databaseUrl: "mysql://user:pass@example.test/pi_agent",
    })).rejects.toThrow("STORAGE_MODE=db requires REDIS_URL");
  });
});
