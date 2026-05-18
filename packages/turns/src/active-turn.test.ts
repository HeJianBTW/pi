import type { RuntimeLifecycleEvent, RuntimeSession } from '@amaster.ai/pi-shared';
import { describe, expect, it } from 'vitest';
import {
  type ActiveChatSession,
  type ActiveTurnInput,
  applyCopilotRuntimeGuidance,
  handleActiveChatTurn,
  type TurnMetrics,
} from './active-turn.js';

const model = { provider: 'openai', model: 'gpt-5', thinkingLevel: 'medium' as const };

describe('active turns', () => {
  it('returns a structured conflict when there is no active turn to steer', async () => {
    const result = await handleActiveChatTurn({
      prepared: prepared({ turnMode: 'steer' }),
      active: undefined,
      sessionIsActive: false,
      maxToolResultsPerTurn: 4,
      logger: noopLogger,
      metrics: metrics(),
      logFields: {},
      recordRuntimeEvent: async () => undefined,
      applySubagentRoutingGuidance: (message) => ({ message, applied: false }),
      toTelemetryText: (value) => value,
    });

    expect(result).toMatchObject({
      handled: true,
      statusCode: 409,
      eventName: 'turn_failed',
      payload: {
        code: 'no_active_turn',
        turnMode: 'steer',
      },
    });
  });

  it('queues steer input into an active session and records lifecycle metadata', async () => {
    const steered: string[] = [];
    const events: RuntimeLifecycleEvent[] = [];
    const counters = metrics();
    const active: ActiveChatSession = {
      traceId: 'trace-active',
      runtime: runtimeSession(),
      pi: {
        steer: (message) => {
          steered.push(message);
        },
      },
    };

    const result = await handleActiveChatTurn({
      prepared: prepared({ turnMode: 'steer', requestedSkills: ['reviewer'] }),
      active,
      sessionIsActive: true,
      maxToolResultsPerTurn: 3,
      logger: noopLogger,
      metrics: counters,
      logFields: {},
      recordRuntimeEvent: async (event) => {
        events.push(event);
      },
      applySubagentRoutingGuidance: (message) => ({
        message: `${message}\nroute`,
        applied: true,
        reason: 'force',
      }),
      toTelemetryText: (value) => value,
    });

    expect(result).toMatchObject({ handled: true, statusCode: 202, eventName: 'turn_queued' });
    expect(counters.chatTurnsQueuedTotal).toBe(1);
    expect(active.extraToolResultBudget).toBe(3);
    expect(active.pendingQueuedInputs).toHaveLength(1);
    expect(active.acceptedQueuedInputs?.[0]).toMatchObject({
      turnMode: 'steer',
      input: 'please adjust',
    });
    expect(steered[0]).toBe(applyCopilotRuntimeGuidance('please adjust\nroute'));
    expect(events[0]).toMatchObject({
      traceId: 'trace-active',
      type: 'chat_turn_steered',
      sessionId: 'session-1',
      details: expect.objectContaining({
        accepted: true,
        queuedIntoActiveTurn: true,
        requestedSkills: ['reviewer'],
      }),
    });
  });
});

function prepared(overrides: Partial<ActiveTurnInput> = {}): ActiveTurnInput {
  return {
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    traceId: 'trace-request',
    model,
    subagentMode: 'auto',
    requestedSkills: [],
    message: 'please adjust',
    originalMessage: 'please adjust',
    ...overrides,
  };
}

function runtimeSession(): RuntimeSession {
  return {
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    tenantId: 'tenant-1',
    model,
    sandboxStatus: 'running',
    toolPolicyProfile: 'sandbox-exec',
  };
}

function metrics(): TurnMetrics {
  return { chatTurnsQueuedTotal: 0 };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
