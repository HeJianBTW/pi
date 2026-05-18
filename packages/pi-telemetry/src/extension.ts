import { randomUUID } from 'node:crypto';
import type { JsonObject, RuntimeModelConfig } from '@amaster.ai/pi-shared';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfigFromFile, resolveConfig } from './config.js';
import {
  CompositeRuntimeEventExporter,
  NoopRuntimeEventExporter,
  type RuntimeEventExporter,
} from './index.js';
import { createLangfuseExporter } from './langfuse.js';
import { createOtelExporter } from './otel.js';

function extractModelConfig(payload: unknown): RuntimeModelConfig {
  if (payload && typeof payload === 'object' && 'model' in payload) {
    const model = (payload as Record<string, unknown>).model;
    if (typeof model === 'string') {
      return { provider: 'unknown', model };
    }
  }
  return { provider: 'unknown', model: 'unknown' };
}

export default function telemetryExtension(pi: ExtensionAPI): void {
  let exporter: RuntimeEventExporter = new NoopRuntimeEventExporter();
  const sessionId = randomUUID();
  let currentTraceId: string | undefined;
  let turnStartTime: number | undefined;
  let llmGenerationCounter = 0;

  pi.on('session_start', async () => {
    const config = resolveConfig(loadConfigFromFile());
    const langfuse = createLangfuseExporter(config);
    const otel = createOtelExporter(config);

    const active = [langfuse, otel].filter((e) => !(e instanceof NoopRuntimeEventExporter));
    if (active.length > 1) {
      exporter = new CompositeRuntimeEventExporter(active);
    } else if (active.length === 1) {
      exporter = active[0]!;
    }
  });

  pi.on('turn_start', async (event) => {
    currentTraceId = randomUUID().replace(/-/g, '');
    turnStartTime = event.timestamp;
    llmGenerationCounter = 0;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      type: 'chat_turn_started',
      sessionId,
      createdAt: new Date(event.timestamp).toISOString(),
    });
  });

  pi.on('turn_end', async () => {
    if (!currentTraceId) return;
    const now = Date.now();
    const durationMs = turnStartTime ? now - turnStartTime : undefined;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      type: 'chat_turn_completed',
      sessionId,
      createdAt: new Date(now).toISOString(),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });

    currentTraceId = undefined;
    turnStartTime = undefined;
  });

  pi.on('tool_execution_start', async (event) => {
    if (!currentTraceId) return;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      sessionId,
      conversationId: sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'started',
      createdAt: new Date().toISOString(),
      args: event.args as JsonObject,
    });
  });

  pi.on('tool_execution_end', async (event) => {
    if (!currentTraceId) return;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      sessionId,
      conversationId: sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: event.isError ? 'failed' : 'completed',
      createdAt: new Date().toISOString(),
      ...(event.isError ? { error: String(event.result) } : {}),
    });
  });

  pi.on('before_provider_request', async (event) => {
    if (!currentTraceId) return;
    llmGenerationCounter++;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      sessionId,
      conversationId: sessionId,
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: 'started',
      createdAt: new Date().toISOString(),
      model: extractModelConfig(event.payload),
    });
  });

  pi.on('after_provider_response', async (event) => {
    if (!currentTraceId) return;

    await exporter.publish({
      id: randomUUID(),
      traceId: currentTraceId,
      sessionId,
      conversationId: sessionId,
      llmGenerationId: `gen-${llmGenerationCounter}`,
      status: event.status >= 400 ? 'failed' : 'completed',
      createdAt: new Date().toISOString(),
      model: extractModelConfig(undefined),
      ...(event.status >= 400 ? { error: `HTTP ${event.status}` } : {}),
    });
  });

  pi.on('session_shutdown', async () => {
    await exporter.flush?.();
    await exporter.close?.();
  });
}
