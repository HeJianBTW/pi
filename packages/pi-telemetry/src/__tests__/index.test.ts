import type { RuntimeLifecycleEvent, RuntimeToolEvent } from '@amaster.ai/pi-shared';
import { describe, expect, it } from 'vitest';
import {
  CompositeRuntimeEventExporter,
  NoopRuntimeEventExporter,
  type RuntimeTelemetryEvent,
} from '../index.js';
import {
  createRuntimeEventExporterFromEnv as createLangfuseRuntimeEventExporterFromEnv,
  LangfuseHttpRuntimeEventExporter,
  type LangfuseSdkClient,
  type LangfuseSdkGenerationClient,
  LangfuseSdkRuntimeEventExporter,
  type LangfuseSdkSpanClient,
  type LangfuseSdkTraceClient,
  mapRuntimeEventToLangfuse,
  resolveLangfuseConfig,
} from '../langfuse.js';
import {
  createOtelRuntimeEventExporterFromEnv,
  OtelRuntimeEventExporter,
  resolveOtelConfig,
} from '../otel.js';

const traceId = '11111111111111111111111111111111';

describe('telemetry', () => {
  it('keeps root exporters resilient when one delegate fails', async () => {
    const event: RuntimeTelemetryEvent = {
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    };
    const delivered: string[] = [];
    const composite = new CompositeRuntimeEventExporter([
      {
        publish: async () => {
          throw new Error('boom');
        },
        flush: async () => {
          throw new Error('flush failed');
        },
        close: async () => {
          throw new Error('close failed');
        },
      },
      {
        publish: async (published) => {
          delivered.push(published.id);
        },
        flush: async () => {
          delivered.push('flushed');
        },
        close: async () => {
          delivered.push('closed');
        },
      },
    ]);

    await expect(new NoopRuntimeEventExporter().publish(event)).resolves.toBeUndefined();
    await expect(composite.publish(event)).resolves.toBeUndefined();
    await expect(composite.close()).resolves.toBeUndefined();

    expect(delivered).toEqual(['event-1', 'flushed', 'closed']);
  });

  it('keeps Langfuse disabled until keys are present', () => {
    expect(resolveLangfuseConfig({ LANGFUSE_ENABLED: 'true' })).toMatchObject({
      enabled: false,
      transport: 'ingestion',
      baseUrl: 'https://cloud.langfuse.com',
      flushAt: 20,
      flushIntervalMs: 5000,
    });

    expect(
      resolveLangfuseConfig({
        LANGFUSE_ENABLED: '1',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
        LANGFUSE_BASE_URL: 'https://langfuse.example.com/',
        LANGFUSE_FLUSH_AT: '2',
        LANGFUSE_FLUSH_INTERVAL_MS: '100',
      }),
    ).toMatchObject({
      enabled: true,
      transport: 'sdk',
      publicKey: 'public',
      secretKey: 'secret',
      baseUrl: 'https://langfuse.example.com/',
      flushAt: 2,
      flushIntervalMs: 100,
    });

    expect(
      resolveLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
      }),
    ).toMatchObject({
      enabled: true,
      transport: 'sdk',
    });

    expect(
      resolveLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_TRANSPORT: 'ingestion',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
      }),
    ).toMatchObject({
      enabled: true,
      transport: 'ingestion',
    });
  });

  it('creates the requested Langfuse transport from environment', () => {
    expect(createLangfuseRuntimeEventExporterFromEnv({ LANGFUSE_ENABLED: 'true' })).toBeInstanceOf(
      NoopRuntimeEventExporter,
    );
    expect(
      createLangfuseRuntimeEventExporterFromEnv({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_TRANSPORT: 'ingestion',
        LANGFUSE_PUBLIC_KEY: 'public',
        LANGFUSE_SECRET_KEY: 'secret',
      }),
    ).toBeInstanceOf(LangfuseHttpRuntimeEventExporter);
  });

  it('maps chat lifecycle events to Langfuse trace events', () => {
    const event: RuntimeLifecycleEvent = {
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      toolPolicyProfile: 'sandbox-exec',
    };

    const [mapped] = mapRuntimeEventToLangfuse(event);

    expect(mapped?.type).toBe('trace-create');
    expect(mapped?.body).toMatchObject({
      sessionId: 'session-1',
      name: 'copilot-chat-turn',
      metadata: {
        eventType: 'chat_turn_started',
        sessionId: 'session-1',
        conversationId: 'conversation-1',
        model: 'anthropic-compatible/kimi-k2.5',
        thinkingLevel: 'off',
      },
    });
    expect(mapped?.body.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('maps steered chat input to a child Langfuse span', () => {
    const event: RuntimeLifecycleEvent = {
      id: 'steer-event-1',
      traceId,
      type: 'chat_turn_steered',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      toolPolicyProfile: 'sandbox-exec',
      details: {
        input: '开发一个 helloworld 页面',
        turnMode: 'steer',
        accepted: true,
      },
    };

    const [spanCreate, spanUpdate] = mapRuntimeEventToLangfuse(event);

    expect(spanCreate?.type).toBe('span-create');
    expect(spanUpdate?.type).toBe('span-update');
    expect(spanCreate?.body.id).toBe(spanUpdate?.body.id);
    expect(spanCreate?.body).toMatchObject({
      name: 'chat-steer [开发一个 helloworld 页面]',
      input: '开发一个 helloworld 页面',
      metadata: {
        eventType: 'chat_turn_steered',
        details: expect.objectContaining({ turnMode: 'steer' }),
      },
    });
    expect(spanUpdate?.body).toMatchObject({
      output: { accepted: true, turnMode: 'steer' },
    });
  });

  it('maps delivered steered chat input to a child Langfuse span', () => {
    const event: RuntimeLifecycleEvent = {
      id: 'steer-delivered-event-1',
      traceId,
      type: 'chat_turn_steer_delivered',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.000Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      toolPolicyProfile: 'sandbox-exec',
      details: {
        input: '开发一个 helloworld 页面',
        turnMode: 'steer',
        delivered: true,
        acceptedEventId: 'steer-event-1',
      },
    };

    const [spanCreate, spanUpdate] = mapRuntimeEventToLangfuse(event);

    expect(spanCreate?.type).toBe('span-create');
    expect(spanUpdate?.type).toBe('span-update');
    expect(spanCreate?.body).toMatchObject({
      name: 'chat-steer-delivered [开发一个 helloworld 页面]',
      input: '开发一个 helloworld 页面',
      metadata: {
        eventType: 'chat_turn_steer_delivered',
        details: expect.objectContaining({ acceptedEventId: 'steer-event-1' }),
      },
    });
    expect(spanUpdate?.body).toMatchObject({
      output: { delivered: true, turnMode: 'steer' },
    });
  });

  it('maps tool started and completed events to stable Langfuse spans', () => {
    const started: RuntimeToolEvent = {
      id: 'tool-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.000Z',
      args: { path: 'README.md' },
    };
    const completed: RuntimeToolEvent = {
      ...started,
      id: 'tool-event-2',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 1000,
      details: { policy: 'allow' },
    };

    const [spanCreate] = mapRuntimeEventToLangfuse(started);
    const [spanUpdate] = mapRuntimeEventToLangfuse(completed);

    expect(spanCreate?.type).toBe('span-create');
    expect(spanUpdate?.type).toBe('span-update');
    expect(spanCreate?.body.id).toBe(spanUpdate?.body.id);
    expect(spanCreate?.body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(spanCreate?.body).toMatchObject({
      name: 'read_file [README.md]',
      input: { path: 'README.md' },
    });
    expect(spanUpdate?.body).toMatchObject({
      output: { policy: 'allow' },
      metadata: { durationMs: 1000 },
    });
  });

  it('flushes Langfuse batches with basic auth', async () => {
    const requests: Array<{
      input: string;
      init: { headers: Record<string, string>; body: string };
    }> = [];
    const exporter = new LangfuseHttpRuntimeEventExporter(
      {
        enabled: true,
        transport: 'ingestion',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com/',
        flushAt: 2,
        flushIntervalMs: 60_000,
      },
      async (input, init) => {
        requests.push({ input, init });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    expect(requests).toHaveLength(0);

    await exporter.publish({
      id: 'event-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 1000,
      details: { output: 'world' },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe('https://langfuse.example.com/api/public/ingestion');
    expect(requests[0]?.init.headers.authorization).toBe('Basic cHVibGljOnNlY3JldA==');
    expect(JSON.parse(requests[0]?.init.body ?? '{}')).toMatchObject({
      batch: [
        { type: 'trace-create', body: { input: 'hello' } },
        { type: 'trace-update', body: { output: 'world' } },
      ],
    });
  });

  it('keeps failed Langfuse batches queued for retry', async () => {
    let attempt = 0;
    const exporter = new LangfuseHttpRuntimeEventExporter(
      {
        enabled: true,
        transport: 'ingestion',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
        }
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });

    await expect(exporter.flush()).rejects.toThrow('Langfuse ingestion failed with 503');
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  it('strips payloads before exporting Langfuse ingestion events', async () => {
    const requests: Array<{ init: { body: string } }> = [];
    const exporter = new LangfuseHttpRuntimeEventExporter(
      {
        enabled: true,
        transport: 'ingestion',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
        includePayloads: false,
      },
      async (_input, init) => {
        requests.push({ init });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'secret prompt', output: 'draft', content: 'raw content', kept: true },
    });
    await exporter.publish({
      id: 'tool-event-1',
      traceId,
      sessionId: 'session-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      args: { command: 'cat private.txt' },
      details: { args: { command: 'cat private.txt' }, kept: true },
    });
    await exporter.flush();

    const body = requests[0]?.init.body ?? '';
    expect(body).not.toContain('secret prompt');
    expect(body).not.toContain('raw content');
    expect(body).not.toContain('cat private.txt');
    expect(JSON.parse(body)).toMatchObject({
      batch: [
        { body: { metadata: { details: { kept: true } } } },
        { body: { metadata: { details: { kept: true } } } },
      ],
    });
  });

  it('allows redaction hooks to drop telemetry events', async () => {
    const requests: Array<{ init: { body: string } }> = [];
    const exporter = new LangfuseHttpRuntimeEventExporter(
      {
        enabled: true,
        transport: 'ingestion',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
        redactEvent: (event) => (event.id === 'drop-me' ? undefined : event),
      },
      async (_input, init) => {
        requests.push({ init });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'drop-me',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await exporter.publish({
      id: 'keep-me',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
    });
    await exporter.flush();

    expect(JSON.parse(requests[0]?.init.body ?? '{}').batch).toHaveLength(1);
  });

  it('exports completed spans through a generic OTEL traces endpoint', async () => {
    expect(
      resolveOtelConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token,x-tenant=demo',
        OTEL_SERVICE_NAME: 'pi-test',
        TELEMETRY_INCLUDE_PAYLOADS: 'false',
      }),
    ).toMatchObject({
      enabled: true,
      endpoint: 'https://otel.example.com',
      headers: {
        authorization: 'Bearer token',
        'x-tenant': 'demo',
      },
      serviceName: 'pi-test',
      includePayloads: false,
    });

    const requests: Array<{
      input: string;
      init: { headers: Record<string, string>; body: string };
    }> = [];
    const exporter = createOtelRuntimeEventExporterFromEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20token',
        OTEL_SERVICE_NAME: 'pi-test',
        TELEMETRY_INCLUDE_PAYLOADS: 'false',
      },
      async (input, init) => {
        requests.push({ input, init });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'otel-event-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:01.000Z',
      details: { output: 'world' },
    });
    await exporter.flush?.();

    expect(exporter).toBeInstanceOf(OtelRuntimeEventExporter);
    expect(requests[0]?.input).toBe('https://otel.example.com/v1/traces');
    expect(requests[0]?.init.headers.authorization).toBe('Bearer token');
    const payload = JSON.parse(requests[0]?.init.body ?? '{}');
    const resourceAttributes = payload.resourceSpans[0].resource.attributes;
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(getStringAttribute({ attributes: resourceAttributes }, 'service.name')).toBe('pi-test');
    expect(getStringAttribute(span, 'langfuse.observation.input')).toBeUndefined();
    expect(getStringAttribute(span, 'langfuse.observation.output')).toBeUndefined();
    expect(requests[0]?.init.body).not.toContain('hello');
    expect(requests[0]?.init.body).not.toContain('world');
  });

  it('keeps OTEL disabled without an endpoint and preserves trace endpoint paths', async () => {
    expect(createOtelRuntimeEventExporterFromEnv({})).toBeInstanceOf(NoopRuntimeEventExporter);
    expect(
      createOtelRuntimeEventExporterFromEnv({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      }),
    ).toBeInstanceOf(NoopRuntimeEventExporter);

    const requests: Array<{ input: string }> = [];
    const exporter = new OtelRuntimeEventExporter(
      {
        enabled: true,
        endpoint: 'https://otel.example.com/v1/traces',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      async (input) => {
        requests.push({ input });
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
    });
    await exporter.flush();

    expect(requests[0]?.input).toBe('https://otel.example.com/v1/traces');
  });

  it('keeps failed OTEL batches queued for retry', async () => {
    let attempt = 0;
    const exporter = new OtelRuntimeEventExporter(
      {
        enabled: true,
        endpoint: 'https://otel.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, status: 502, text: async () => 'bad gateway' };
        }
        return { ok: true, status: 200, text: async () => '' };
      },
    );

    await exporter.publish({
      id: 'otel-event-1',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      createdAt: '2026-05-02T00:00:01.000Z',
    });

    await expect(exporter.flush()).rejects.toThrow('OTEL export failed with 502');
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  it('exports traces and nested spans through the Langfuse SDK transport', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        transport: 'sdk',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'tool-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.500Z',
      args: { command: 'pwd' },
    });
    await exporter.publish({
      id: 'tool-event-2',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      toolCallId: 'call-1',
      toolName: 'run_shell',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 500,
      details: { exitCode: 0 },
    });
    await exporter.publish({
      id: 'event-2',
      traceId,
      type: 'chat_turn_completed',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:02.000Z',
      durationMs: 2000,
      details: { output: 'world' },
    });
    await exporter.flush();
    await exporter.close();

    expect(client.traces).toHaveLength(1);
    expect(client.flushed).toBe(1);
    expect(client.closed).toBe(1);
    expect(client.traces[0]?.body).toMatchObject({
      sessionId: 'session-1',
      name: 'copilot-chat-turn',
      input: 'hello',
    });
    expect(client.traces[0]?.updates.at(-1)).toMatchObject({
      output: 'world',
      metadata: { durationMs: 2000 },
    });
    const rootSpan = client.traces[0]?.spans[0];
    const toolSpan = rootSpan?.spans[0];
    expect(rootSpan?.body).toMatchObject({
      name: 'copilot-chat-turn',
      input: 'hello',
      level: 'DEFAULT',
    });
    expect(rootSpan?.updates.at(-1)).toMatchObject({
      output: 'world',
      endTime: '2026-05-02T00:00:02.000Z',
      level: 'DEFAULT',
    });
    expect(toolSpan?.body).toMatchObject({
      name: 'run_shell [pwd]',
      input: { args: { command: 'pwd' } },
      level: 'DEFAULT',
    });
    expect(toolSpan?.updates.at(-1)).toMatchObject({
      output: { exitCode: 0 },
      endTime: '2026-05-02T00:00:01.000Z',
      level: 'DEFAULT',
    });
  });

  it('exports LLM generations as Langfuse generations with usage', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        transport: 'sdk',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'event-1',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'hello' },
    });
    await exporter.publish({
      id: 'model-event-1',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.100Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      input: 'hello',
    });
    await exporter.publish({
      id: 'model-event-2',
      traceId,
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      llmGenerationId: 'call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:01.000Z',
      durationMs: 900,
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      output: 'world',
      usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 },
      stopReason: 'stop',
    });

    const generation = client.traces[0]?.spans[0]?.generations[0];
    expect(generation?.body).toMatchObject({
      name: 'llm-generation [main] [hello]',
      model: 'kimi-k2.5',
      input: 'hello',
    });
    expect(generation?.updates.at(-1)).toMatchObject({
      output: 'world',
      endTime: '2026-05-02T00:00:01.000Z',
      level: 'DEFAULT',
      usage: { input: 10, output: 3, total: 16, unit: 'TOKENS' },
      usageDetails: { input: 10, output: 3, cache_read: 2, cache_write: 1, total: 16 },
    });
  });

  it('nests subagent model and tool observations under the subagent span', async () => {
    const client = new FakeLangfuseSdkClient();
    const exporter = new LangfuseSdkRuntimeEventExporter(
      {
        enabled: true,
        transport: 'sdk',
        publicKey: 'public',
        secretKey: 'secret',
        baseUrl: 'https://langfuse.example.com',
        flushAt: 10,
        flushIntervalMs: 60_000,
      },
      client,
    );

    await exporter.publish({
      id: 'root-start',
      traceId,
      type: 'chat_turn_started',
      sessionId: 'parent',
      conversationId: 'parent',
      createdAt: '2026-05-02T00:00:00.000Z',
      details: { input: 'parent task' },
    });
    await exporter.publish({
      id: 'spawn-tool-start',
      traceId,
      sessionId: 'parent',
      conversationId: 'parent',
      toolCallId: 'spawn-call-1',
      toolName: 'sessions_spawn',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.050Z',
      args: { task: 'child task' },
    });
    await exporter.publish({
      id: 'subagent-start',
      traceId,
      type: 'subagent_started',
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      parentToolCallId: 'spawn-call-1',
      createdAt: '2026-05-02T00:00:00.100Z',
      details: {
        input: 'child task',
        taskRunId: 'run-1',
        spawnBatchId: 'trace:11111111111111111111111111111111',
      },
    });
    await exporter.publish({
      id: 'child-model-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-call-1',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.200Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      input: 'child task',
    });
    await exporter.publish({
      id: 'child-model-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      llmGenerationId: 'child-call-1',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.500Z',
      model: { provider: 'anthropic-compatible', model: 'kimi-k2.5', thinkingLevel: 'off' },
      output: 'child answer',
    });
    await exporter.publish({
      id: 'child-tool-start',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'started',
      createdAt: '2026-05-02T00:00:00.600Z',
      args: { path: 'README.md' },
    });
    await exporter.publish({
      id: 'child-tool-done',
      traceId,
      sessionId: 'parent:subagent:1',
      conversationId: 'parent:subagent:1',
      parentSessionId: 'parent',
      childSessionId: 'parent:subagent:1',
      runId: 'run-1',
      taskRunId: 'run-1',
      spawnBatchId: 'trace:11111111111111111111111111111111',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      status: 'completed',
      createdAt: '2026-05-02T00:00:00.700Z',
      details: { policy: 'allow' },
    });

    const trace = client.traces.find((candidate) => candidate.body.sessionId === 'parent');
    const rootSpan = trace?.spans[0];
    const spawnToolSpan = rootSpan?.spans.find(
      (span) => span.body.name === 'sessions_spawn [child task]',
    );
    const batchSpan = rootSpan?.spans.find((span) => span.body.name === 'subagent fan-out');
    const subagentSpan = batchSpan?.spans[0];
    expect(trace?.body).toMatchObject({ sessionId: 'parent' });
    expect(rootSpan?.body).toMatchObject({ name: 'copilot-chat-turn' });
    expect(spawnToolSpan?.body).toMatchObject({ name: 'sessions_spawn [child task]' });
    expect(batchSpan?.body).toMatchObject({
      name: 'subagent fan-out',
      metadata: { spawnBatchId: '11111111' },
    });
    expect(subagentSpan?.body).toMatchObject({ name: 'subagent' });
    expect(subagentSpan?.generations[0]?.body).toMatchObject({
      name: 'llm-generation [subagent] [child task]',
      input: 'child task',
    });
    expect(subagentSpan?.spans[0]?.body).toMatchObject({
      name: 'read_file [README.md]',
      input: { args: { path: 'README.md' } },
    });
  });
});

function getStringAttribute(
  span: { attributes: Array<{ key: string; value: { stringValue?: string } }> },
  key: string,
): string | undefined {
  return span.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
}

class FakeLangfuseSdkClient implements LangfuseSdkClient {
  readonly traces: FakeLangfuseSdkTraceClient[] = [];
  flushed = 0;
  closed = 0;

  trace(body?: Record<string, unknown>): LangfuseSdkTraceClient {
    const trace = new FakeLangfuseSdkTraceClient(body ?? {});
    this.traces.push(trace);
    return trace;
  }

  async flushAsync(): Promise<void> {
    this.flushed += 1;
  }

  async shutdownAsync(): Promise<void> {
    this.closed += 1;
  }
}

class FakeLangfuseSdkTraceClient implements LangfuseSdkTraceClient {
  readonly updates: Array<Record<string, unknown>> = [];
  readonly spans: FakeLangfuseSdkSpanClient[] = [];
  readonly generations: FakeLangfuseSdkGenerationClient[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }

  span(body: Record<string, unknown>): LangfuseSdkSpanClient {
    const span = new FakeLangfuseSdkSpanClient(body);
    this.spans.push(span);
    return span;
  }

  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient {
    const generation = new FakeLangfuseSdkGenerationClient(body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuseSdkSpanClient implements LangfuseSdkSpanClient {
  readonly updates: Array<Record<string, unknown>> = [];
  readonly spans: FakeLangfuseSdkSpanClient[] = [];
  readonly generations: FakeLangfuseSdkGenerationClient[] = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }

  span(body: Record<string, unknown>): LangfuseSdkSpanClient {
    const span = new FakeLangfuseSdkSpanClient(body);
    this.spans.push(span);
    return span;
  }

  generation(body: Record<string, unknown>): LangfuseSdkGenerationClient {
    const generation = new FakeLangfuseSdkGenerationClient(body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuseSdkGenerationClient implements LangfuseSdkGenerationClient {
  readonly updates: Array<Record<string, unknown>> = [];

  constructor(readonly body: Record<string, unknown>) {}

  update(body: Record<string, unknown>): unknown {
    this.updates.push(body);
    return this;
  }
}
