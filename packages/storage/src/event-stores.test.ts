import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileRuntimeTimelineEventStore } from "./event-stores.js";

const tmpDirs: string[] = [];

describe("JsonFileRuntimeTimelineEventStore", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("assigns per-session eventSeq and returns events in timeline order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-2", "session-1", "tool_call_started"));
    await store.append(event("event-3", "session-2", "runtime_event"));
    await store.append(event("event-4", "session-1", "tool_call_completed"));

    expect(await store.list({ tenantId: "tenant-1", sessionId: "session-1" })).toMatchObject([
      { eventId: "event-1", eventSeq: 1, eventName: "runtime_event" },
      { eventId: "event-2", eventSeq: 2, eventName: "tool_call_started" },
      { eventId: "event-4", eventSeq: 3, eventName: "tool_call_completed" },
    ]);
    expect(await store.list({ tenantId: "tenant-1", sessionId: "session-2" })).toMatchObject([
      { eventId: "event-3", eventSeq: 1, eventName: "runtime_event" },
    ]);
  });

  it("supports afterSeq replay windows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-2", "session-1", "tool_call_started"));
    await store.append(event("event-3", "session-1", "tool_call_completed"));

    expect(await store.list({ tenantId: "tenant-1", sessionId: "session-1", afterSeq: 1 })).toMatchObject([
      { eventId: "event-2", eventSeq: 2 },
      { eventId: "event-3", eventSeq: 3 },
    ]);
  });

  it("supports stable createdAt/eventId cursor paging over merged timeline order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-2", "session-1:subagent:child", "tool_call_started", {
      parentSessionId: "session-1",
    }));
    await store.append(event("event-3", "session-1", "assistant_text_delta"));
    await store.append(event("event-4", "session-1:subagent:child", "tool_call_completed", {
      parentSessionId: "session-1",
    }));

    const firstPage = await store.list({ tenantId: "tenant-1", sessionId: "session-1", limit: 3 });
    expect(firstPage.map((entry) => entry.eventId)).toEqual(["event-2", "event-3", "event-4"]);

    const secondPage = await store.list({
      tenantId: "tenant-1",
      sessionId: "session-1",
      limit: 3,
      cursor: { createdAt: firstPage[0]?.createdAt ?? "", eventId: firstPage[0]?.eventId ?? "" },
    });
    expect(secondPage.map((entry) => entry.eventId)).toEqual(["event-1"]);
  });

  it("treats eventId as append idempotency key", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-2", "session-1", "tool_call_started"));

    expect(await store.list({ tenantId: "tenant-1", sessionId: "session-1" })).toMatchObject([
      { eventId: "event-1", eventSeq: 1 },
      { eventId: "event-2", eventSeq: 2 },
    ]);
  });

  it("serializes concurrent appends without duplicate eventSeq values", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.append(event(`event-${index + 1}`, "session-1", "runtime_event"))
    ));

    const events = await store.list({ tenantId: "tenant-1", sessionId: "session-1" });
    expect(events).toHaveLength(20);
    expect(events.map((entry) => entry.eventSeq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(events.map((entry) => entry.eventSeq)).size).toBe(20);
  });

  it("waits for queued writes before listing events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, "events.json"), 100);

    const append = store.append(event("event-1", "session-1", "runtime_event"));

    await expect(store.list({ tenantId: "tenant-1", sessionId: "session-1" })).resolves.toMatchObject([
      { eventId: "event-1", eventSeq: 1 },
    ]);
    await append;
  });

  it("recovers from a corrupt primary file using the backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-events-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "events.json");
    const store = new JsonFileRuntimeTimelineEventStore(filePath, 100);

    await store.append(event("event-1", "session-1", "runtime_event"));
    await store.append(event("event-2", "session-1", "runtime_event"));
    await writeFile(filePath, "[");

    expect(await store.list({ tenantId: "tenant-1", sessionId: "session-1" })).toMatchObject([
      { eventId: "event-1", eventSeq: 1 },
    ]);
  });
});

function event(
  eventId: string,
  sessionId: string,
  eventName: string,
  extra: { parentSessionId?: string; childSessionId?: string; runId?: string } = {},
) {
  const sequenceHint = Number(eventId.match(/\d+/)?.[0] ?? 0);
  const createdAt = new Date(Date.UTC(2026, 4, 13, 0, 0, 0, sequenceHint)).toISOString();
  return {
    eventId,
    eventName,
    eventType: eventName,
    eventSource: eventName.startsWith("tool_") ? "tool" as const : "runtime" as const,
    sessionId,
    conversationId: sessionId,
    createdAt,
    payload: { id: eventId, sessionId, createdAt },
    ...extra,
  };
}
