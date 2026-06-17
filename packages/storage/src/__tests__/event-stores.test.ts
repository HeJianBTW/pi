import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileRuntimeTimelineEventStore } from '../event-stores.js';

const tmpDirs: string[] = [];

describe('JsonFileRuntimeTimelineEventStore', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('assigns per-session eventSeq and returns events in timeline order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(event('event-2', 'session-1', 'tool_call_started'));
    await store.append(event('event-3', 'session-2', 'runtime_event'));
    await store.append(event('event-4', 'session-1', 'tool_call_completed'));

    expect(await store.list({ tenantId: 'tenant-1', sessionId: 'session-1' })).toMatchObject([
      { eventId: 'event-1', eventSeq: 1, eventName: 'runtime_event' },
      { eventId: 'event-2', eventSeq: 2, eventName: 'tool_call_started' },
      { eventId: 'event-4', eventSeq: 3, eventName: 'tool_call_completed' },
    ]);
    expect(await store.list({ tenantId: 'tenant-1', sessionId: 'session-2' })).toMatchObject([
      { eventId: 'event-3', eventSeq: 1, eventName: 'runtime_event' },
    ]);
  });

  it('supports afterSeq replay windows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(event('event-2', 'session-1', 'tool_call_started'));
    await store.append(event('event-3', 'session-1', 'tool_call_completed'));

    expect(
      await store.list({ tenantId: 'tenant-1', sessionId: 'session-1', afterSeq: 1 }),
    ).toMatchObject([
      { eventId: 'event-2', eventSeq: 2 },
      { eventId: 'event-3', eventSeq: 3 },
    ]);
  });

  it('preserves append order for events written in the same millisecond', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));
    const createdAt = '2026-05-13T00:00:00.000Z';

    await store.append(event('z-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));
    await store.append(event('a-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));
    await store.append(event('m-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));

    expect(
      (await store.list({ tenantId: 'tenant-1', sessionId: 'session-1' })).map(
        (entry) => entry.eventId,
      ),
    ).toEqual(['z-delta', 'a-delta', 'm-delta']);
  });

  it('supports stable createdAt/eventSeq cursor paging over merged timeline order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(
      event('event-2', 'session-1:subagent:child', 'tool_call_started', {
        parentSessionId: 'session-1',
      }),
    );
    await store.append(event('event-3', 'session-1', 'assistant_text_delta'));
    await store.append(
      event('event-4', 'session-1:subagent:child', 'tool_call_completed', {
        parentSessionId: 'session-1',
      }),
    );

    const firstPage = await store.list({ tenantId: 'tenant-1', sessionId: 'session-1', limit: 3 });
    expect(firstPage.map((entry) => entry.eventId)).toEqual(['event-2', 'event-3', 'event-4']);

    const secondPage = await store.list({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      limit: 3,
      cursor: { createdAt: firstPage[0]?.createdAt ?? '', eventId: firstPage[0]?.eventId ?? '' },
    });
    expect(secondPage.map((entry) => entry.eventId)).toEqual(['event-1']);
  });

  it('uses eventSeq for cursor paging across same-millisecond events', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));
    const createdAt = '2026-05-13T00:00:00.000Z';

    await store.append(event('z-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));
    await store.append(event('a-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));
    await store.append(event('m-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));
    await store.append(event('q-delta', 'session-1', 'assistant_thinking_delta', { createdAt }));

    const firstPage = await store.list({ tenantId: 'tenant-1', sessionId: 'session-1', limit: 2 });
    expect(firstPage.map((entry) => entry.eventId)).toEqual(['m-delta', 'q-delta']);

    const secondPage = await store.list({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      limit: 2,
      cursor: { createdAt: firstPage[0]?.createdAt ?? '', eventId: firstPage[0]?.eventId ?? '' },
    });
    expect(secondPage.map((entry) => entry.eventId)).toEqual(['z-delta', 'a-delta']);
  });

  it('treats eventId as append idempotency key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(event('event-2', 'session-1', 'tool_call_started'));

    expect(await store.list({ tenantId: 'tenant-1', sessionId: 'session-1' })).toMatchObject([
      { eventId: 'event-1', eventSeq: 1 },
      { eventId: 'event-2', eventSeq: 2 },
    ]);
  });

  it('serializes concurrent appends without duplicate eventSeq values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.append(event(`event-${index + 1}`, 'session-1', 'runtime_event')),
      ),
    );

    const events = await store.list({ tenantId: 'tenant-1', sessionId: 'session-1' });
    expect(events).toHaveLength(20);
    expect(events.map((entry) => entry.eventSeq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(new Set(events.map((entry) => entry.eventSeq)).size).toBe(20);
  });

  it('waits for queued writes before listing events', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    const append = store.append(event('event-1', 'session-1', 'runtime_event'));

    await expect(
      store.list({ tenantId: 'tenant-1', sessionId: 'session-1' }),
    ).resolves.toMatchObject([{ eventId: 'event-1', eventSeq: 1 }]);
    await append;
  });

  it('indexes parent and child session shards without changing eventSeq', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-events-'));
    tmpDirs.push(dir);
    const store = new JsonFileRuntimeTimelineEventStore(path.join(dir, 'events'));

    await store.append(event('event-1', 'session-1', 'runtime_event'));
    await store.append(
      event('event-2', 'session-1:subagent:child', 'tool_call_started', {
        parentSessionId: 'session-1',
      }),
    );

    await expect(
      store.list({ tenantId: 'tenant-1', sessionId: 'session-1' }),
    ).resolves.toMatchObject([
      { eventId: 'event-1', eventSeq: 1 },
      { eventId: 'event-2', eventSeq: 1 },
    ]);
    await expect(
      store.list({ tenantId: 'tenant-1', sessionId: 'session-1:subagent:child' }),
    ).resolves.toMatchObject([{ eventId: 'event-2', eventSeq: 1 }]);
  });
});

function event(
  eventId: string,
  sessionId: string,
  eventName: string,
  extra: {
    parentSessionId?: string;
    childSessionId?: string;
    runId?: string;
    createdAt?: string;
  } = {},
) {
  const sequenceHint = Number(eventId.match(/\d+/)?.[0] ?? 0);
  const createdAt =
    extra.createdAt ?? new Date(Date.UTC(2026, 4, 13, 0, 0, 0, sequenceHint)).toISOString();
  const { createdAt: _createdAt, ...extraFields } = extra;
  return {
    eventId,
    eventName,
    eventType: eventName,
    eventSource: eventName.startsWith('tool_') ? ('tool' as const) : ('runtime' as const),
    sessionId,
    conversationId: sessionId,
    createdAt,
    payload: { id: eventId, sessionId, createdAt },
    ...extraFields,
  };
}
