import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeTelemetryEvent } from '../index.js';

vi.mock('../langfuse.js', () => ({
  createRuntimeEventExporterFromEnv: vi.fn(() => ({
    publish: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../otel.js', () => ({
  createOtelRuntimeEventExporterFromEnv: vi.fn(() => ({
    publish: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

import { createRuntimeEventExporterFromEnv } from '../langfuse.js';
import { createOtelRuntimeEventExporterFromEnv } from '../otel.js';
import { NoopRuntimeEventExporter } from '../index.js';

type EventHandler = (...args: any[]) => Promise<void> | void;

const handlers = new Map<string, EventHandler>();

const mockPi = {
  registerTool: vi.fn(),
  on: vi.fn((event: string, handler: EventHandler) => {
    handlers.set(event, handler);
  }),
};

const { default: telemetryExtension } = await import('../extension.js');

async function fireEvent(name: string, event?: unknown) {
  const handler = handlers.get(name);
  if (handler) await handler(event, {});
}

function getPublishedEvents(): RuntimeTelemetryEvent[] {
  const langfuseExporter = (createRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mock
    .results[0]?.value;
  if (!langfuseExporter) return [];
  return (langfuseExporter.publish as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => call[0] as RuntimeTelemetryEvent,
  );
}

describe('telemetryExtension', () => {
  beforeEach(() => {
    handlers.clear();
    mockPi.on.mockClear();
    mockPi.registerTool.mockClear();
    (createRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mockClear();
    (createOtelRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mockClear();

    (createRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn(() => Promise.resolve()),
      flush: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    });
    (createOtelRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mockReturnValue(
      new NoopRuntimeEventExporter(),
    );
  });

  test('registers expected event handlers', () => {
    telemetryExtension(mockPi as any);

    const registered = mockPi.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).toContain('session_start');
    expect(registered).toContain('session_shutdown');
    expect(registered).toContain('turn_start');
    expect(registered).toContain('turn_end');
    expect(registered).toContain('tool_execution_start');
    expect(registered).toContain('tool_execution_end');
    expect(registered).toContain('before_provider_request');
    expect(registered).toContain('after_provider_response');
  });

  test('initializes exporter from env on session_start', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    expect(createRuntimeEventExporterFromEnv).toHaveBeenCalledTimes(1);
    expect(createOtelRuntimeEventExporterFromEnv).toHaveBeenCalledTimes(1);
  });

  test('publishes chat_turn_started on turn_start', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: 1700000000000 });

    const events = getPublishedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'chat_turn_started',
      createdAt: '2023-11-14T22:13:20.000Z',
    });
    expect(events[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]!.sessionId).toBeTruthy();
  });

  test('publishes chat_turn_completed on turn_end with durationMs', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const startTs = Date.now();
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: startTs });
    await fireEvent('turn_end', {
      type: 'turn_end',
      turnIndex: 0,
      message: {},
      toolResults: [],
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(2);
    const completed = events[1]!;
    expect(completed).toMatchObject({ type: 'chat_turn_completed' });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.traceId).toBe(events[0]!.traceId);
  });

  test('uses new traceId for each turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const events = getPublishedEvents();
    expect(events[0]!.traceId).not.toBe(events[2]!.traceId);
  });

  test('publishes tool started event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: 'README.md' },
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'started',
      args: { path: 'README.md' },
    });
  });

  test('publishes tool completed event', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'file contents',
      isError: false,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
    });
  });

  test('publishes tool failed event with error', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'ENOENT: file not found',
      isError: true,
    });

    const events = getPublishedEvents();
    const toolEvent = events.find((e) => 'toolCallId' in e);
    expect(toolEvent).toMatchObject({
      status: 'failed',
      error: 'ENOENT: file not found',
    });
  });

  test('publishes LLM generation started from before_provider_request', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { model: 'claude-3-opus-20240229', messages: [] },
    });

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      llmGenerationId: 'gen-1',
      status: 'started',
      model: { provider: 'unknown', model: 'claude-3-opus-20240229' },
    });
  });

  test('publishes LLM generation completed from after_provider_response', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { model: 'claude-3-opus-20240229' },
    });
    await fireEvent('after_provider_response', {
      type: 'after_provider_response',
      status: 200,
      headers: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents).toHaveLength(2);
    expect(llmEvents[1]).toMatchObject({
      llmGenerationId: 'gen-1',
      status: 'completed',
    });
  });

  test('publishes LLM generation failed for 4xx/5xx responses', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('after_provider_response', {
      type: 'after_provider_response',
      status: 429,
      headers: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[1]).toMatchObject({
      status: 'failed',
      error: 'HTTP 429',
    });
  });

  test('extracts model from payload when present', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { model: 'gpt-4o' },
    });

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      model: { provider: 'unknown', model: 'gpt-4o' },
    });
  });

  test('falls back to unknown model when payload has no model field', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: { messages: [] },
    });

    const events = getPublishedEvents();
    const llmEvent = events.find((e) => 'llmGenerationId' in e);
    expect(llmEvent).toMatchObject({
      model: { provider: 'unknown', model: 'unknown' },
    });
  });

  test('increments llmGenerationId for multiple requests in same turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('after_provider_response', {
      type: 'after_provider_response',
      status: 200,
      headers: {},
    });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(llmEvents[2]).toMatchObject({ llmGenerationId: 'gen-2' });
  });

  test('resets llmGenerationId counter on new turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    const llmEvents = events.filter((e) => 'llmGenerationId' in e);
    expect(llmEvents[0]).toMatchObject({ llmGenerationId: 'gen-1' });
    expect(llmEvents[1]).toMatchObject({ llmGenerationId: 'gen-1' });
  });

  test('flushes and closes exporter on session_shutdown', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    const langfuseExporter = (createRuntimeEventExporterFromEnv as ReturnType<typeof vi.fn>).mock
      .results[0]?.value;

    await fireEvent('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

    expect(langfuseExporter.flush).toHaveBeenCalledTimes(1);
    expect(langfuseExporter.close).toHaveBeenCalledTimes(1);
  });

  test('ignores tool events outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: {},
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  test('ignores LLM events outside of a turn', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('before_provider_request', {
      type: 'before_provider_request',
      payload: {},
    });

    const events = getPublishedEvents();
    expect(events).toHaveLength(0);
  });

  test('uses same sessionId across turns', async () => {
    telemetryExtension(mockPi as any);
    await fireEvent('session_start', { type: 'session_start', reason: 'startup' });

    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    await fireEvent('turn_end', { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] });
    await fireEvent('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });

    const events = getPublishedEvents();
    expect(events[0]!.sessionId).toBe(events[2]!.sessionId);
  });
});
