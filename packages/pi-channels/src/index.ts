import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ChatBridge } from './bridge.js';
import { loadChannelConfig, updateLocalChannelConfig } from './config.js';
import { ChannelRegistry } from './registry.js';
import type { ChannelAdapter, ChannelConfig, ChannelMessage, IncomingMessage } from './types.js';

type NotifyParams = {
  action: 'send' | 'list' | 'list-adapters' | 'list-routes' | 'test';
  adapter?: string;
  recipient?: string;
  text?: string;
  source?: string;
  json?: string;
  payloadMode?: 'envelope' | 'raw';
  method?: string;
  contentType?: string;
};

type CaptureWaiter = {
  adapter: string;
  captureToken?: string;
  callback: (result: { ok: boolean; message?: IncomingMessage; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AdapterConnectionState = {
  state: 'connected' | 'connecting' | 'disconnected' | 'error';
  updatedAt: string;
  connectedAt?: string;
  error?: string;
};

type ChannelRuntimeContext = {
  cwd: string;
  ui: Pick<ExtensionContext['ui'], 'notify' | 'setStatus'>;
};

const RECONNECT_DELAYS_MS = [1_000, 3_000, 10_000];
const RECONNECT_STABLE_RESET_MS = 60_000;

function enumSchema(values: string[], description: string): unknown {
  return Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );
}

export default function piChannelsExtension(pi: ExtensionAPI): void {
  const registry = new ChannelRegistry();
  let bridge: ChatBridge | null = null;
  let sessionCwd = process.cwd();
  let currentCtx: ChannelRuntimeContext | null = null;
  let configFingerprint = '';
  let configReloading = false;
  let connectedAt: string | undefined;
  let lastError: string | undefined;
  let adapterStates: Record<string, AdapterConnectionState> = {};
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectResetTimer: ReturnType<typeof setTimeout> | undefined;
  const captureWaiters = new Set<CaptureWaiter>();

  const log = (event: string, data?: Record<string, unknown>, level = 'INFO') => {
    if (event === 'wecom-server-disconnected' || event === 'wecom-client-error') {
      const error = typeof data?.error === 'string' ? data.error : event;
      const adapter = typeof data?.adapter === 'string' ? data.adapter : undefined;
      lastError = error;
      connectedAt = undefined;
      if (adapter) {
        adapterStates = {
          ...adapterStates,
          [adapter]: {
            state: 'error',
            updatedAt: new Date().toISOString(),
            error,
          },
        };
      }
      scheduleReconnect(event, error);
    }
    if (level === 'ERROR') console.error('[pi-channels]', event, data ?? {});
    else console.debug('[pi-channels]', event, data ?? {});
  };
  registry.setLogger(log);

  registry.setOnIncoming(async (message) => {
    pi.events.emit('channel:receive', message);
    const captured = notifyCaptureWaiters(message);
    autoFillEmptyRouteRecipient(sessionCwd, message, log);
    if (captured) return;
    const turn = bridge?.isActive() ? channelIncomingTurn(message) : undefined;
    if (turn) pi.events.emit('channel:turn', turn);
    if (bridge?.isActive()) await bridge.handleMessage(message);
  });

  async function applyChannelConfig(
    ctx: ChannelRuntimeContext,
    reason: string,
    force = false,
  ): Promise<Array<{ adapter: string; error: string }>> {
    if (configReloading) return registry.getErrors();
    configReloading = true;
    try {
      sessionCwd = ctx.cwd;
      const config = loadChannelConfig(ctx.cwd);
      const nextFingerprint = JSON.stringify(config);
      if (!force && nextFingerprint === configFingerprint && !lastError)
        return registry.getErrors();
      configFingerprint = nextFingerprint;
      adapterStates = Object.fromEntries(
        Object.keys(config.adapters ?? {}).map((adapter) => [
          adapter,
          {
            state: 'connecting',
            updatedAt: new Date().toISOString(),
          } satisfies AdapterConnectionState,
        ]),
      );

      bridge?.stop();
      bridge = null;
      await registry.loadConfig(config, ctx.cwd);
      log(reason === 'session_start' ? 'session_start' : 'config_reload', {
        reason,
        cwd: ctx.cwd,
        adapters: Object.keys(config.adapters ?? {}),
        routes: Object.keys(config.routes ?? {}),
        registry: registry.list(),
      });
      await registry.startListening();

      bridge = new ChatBridge(config.bridge, ctx.cwd, registry);
      if (config.bridge?.enabled) bridge.start();

      const errors = registry.getErrors();
      lastError = errors.map((item) => `${item.adapter}: ${item.error}`).join('; ') || undefined;
      connectedAt = errors.length === 0 ? new Date().toISOString() : undefined;
      adapterStates = adapterStatesForRegistry(config, errors, connectedAt);
      if (errors.length === 0) scheduleReconnectAttemptReset();
      for (const error of errors) {
        ctx.ui.notify(`pi-channels: ${error.adapter}: ${error.error}`, 'warning');
      }
      ctx.ui.setStatus?.(
        'pi-channels',
        `channels: ${registry.list().filter((item) => item.type === 'adapter').length}`,
      );
      return errors;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      connectedAt = undefined;
      throw error;
    } finally {
      configReloading = false;
    }
  }

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    if (sessionAutostartDisabled()) {
      sessionCwd = ctx.cwd;
      log('session_start_skipped', {
        reason: 'PI_CHANNELS_DISABLE_SESSION_AUTOSTART',
        cwd: ctx.cwd,
      });
      return;
    }
    currentCtx = ctx;
    sessionCwd = ctx.cwd;
    await applyChannelConfig(ctx, 'session_start', false);
  });

  pi.on('session_shutdown', async (_event: unknown, ctx: ExtensionContext) => {
    currentCtx = null;
    connectedAt = undefined;
    lastError = undefined;
    clearReconnectTimers();
    adapterStates = Object.fromEntries(
      Object.keys(adapterStates).map((adapter) => [
        adapter,
        {
          state: 'disconnected',
          updatedAt: new Date().toISOString(),
        } satisfies AdapterConnectionState,
      ]),
    );
    rejectCaptureWaiters('pi-channels session is shutting down.');
    bridge?.stop();
    bridge = null;
    await registry.stopAll();
    ctx.ui.setStatus?.('pi-channels', undefined);
  });

  pi.registerCommand('channel', {
    description: 'Manage pi channels: /channel [list|reload|bridge on|bridge off|bridge status]',
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      if (tokens[0] === 'reload') {
        await applyChannelConfig(ctx, 'command', true);
        ctx.ui.notify('pi-channels config reloaded.', 'info');
        return;
      }
      if (tokens[0] === 'bridge') {
        if (!bridge) {
          ctx.ui.notify('pi-channels bridge is not initialized.', 'warning');
          return;
        }
        if (tokens[1] === 'on') {
          bridge.start();
          ctx.ui.notify('pi-channels bridge started.', 'info');
          return;
        }
        if (tokens[1] === 'off') {
          bridge.stop();
          ctx.ui.notify('pi-channels bridge stopped.', 'info');
          return;
        }
        const stats = bridge.stats();
        ctx.ui.notify(
          [
            `Bridge active: ${stats.active}`,
            `Sessions: ${stats.sessions}`,
            `Active prompts: ${stats.activePrompts}`,
            `Queued: ${stats.queued}`,
          ].join('\n'),
          'info',
        );
        return;
      }

      const items = registry.list();
      ctx.ui.notify(
        items.length
          ? items
              .map((item) =>
                item.type === 'route'
                  ? `${item.name}${item.label ? ` (${item.label})` : ''} route -> ${item.target}`
                  : `${item.name} adapter (${item.direction})`,
              )
              .join('\n')
          : 'No channels configured.',
        'info',
      );
    },
  });

  pi.registerTool({
    name: 'notify',
    label: 'Channel',
    description:
      'Send messages through configured pi channels. Supports native Feishu, WeCom, and webhooks. Use configured adapter names or route aliases. A chat mention such as @local:channels_wecom:ops means route alias "ops" on the WeCom adapter; @local:channels alone selects the plugin, not a send target.',
    parameters: Type.Object({
      action: enumSchema(
        ['send', 'list', 'list-adapters', 'list-routes', 'test'],
        'Action to perform',
      ) as never,
      adapter: Type.Optional(Type.String({ description: 'Adapter name or route alias.' })),
      recipient: Type.Optional(Type.String({ description: 'Recipient id. Optional for routes.' })),
      text: Type.Optional(Type.String({ description: 'Text to send.' })),
      source: Type.Optional(Type.String({ description: 'Source label.' })),
      json: Type.Optional(Type.String({ description: 'Raw JSON payload for webhook raw mode.' })),
      payloadMode: Type.Optional(enumSchema(['envelope', 'raw'], 'Webhook payload mode') as never),
      method: Type.Optional(Type.String({ description: 'Webhook HTTP method override.' })),
      contentType: Type.Optional(Type.String({ description: 'Webhook Content-Type override.' })),
    }) as never,
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = rawParams as NotifyParams;
      if (
        params.action === 'list' ||
        params.action === 'list-adapters' ||
        params.action === 'list-routes'
      ) {
        const items = registry.list();
        const filteredItems = items.filter((item) => {
          if (params.action === 'list-adapters') return item.type === 'adapter';
          if (params.action === 'list-routes') return item.type === 'route';
          return true;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: filteredItems.length
                ? filteredItems
                    .map((item) =>
                      item.type === 'route'
                        ? `- ${item.name}${item.label ? ` (${item.label})` : ''} route -> ${item.target}`
                        : `- ${item.name} adapter (${item.direction})`,
                    )
                    .join('\n')
                : emptyListMessage(params.action),
            },
          ],
          details: undefined,
        };
      }

      if (!params.adapter) return textToolResult('Missing required field: adapter.');
      const adapterName = normalizeAdapterName(params.adapter, registry.list());
      if (!adapterName.ok) return textToolResult(adapterName.error);

      let rawBody: unknown;
      if (params.json) {
        try {
          rawBody = JSON.parse(params.json);
        } catch (error) {
          return textToolResult(
            `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const webhook: ChannelMessage['webhook'] = {};
      if (params.method) webhook.method = params.method;
      if (params.contentType) webhook.contentType = params.contentType;

      const text =
        params.action === 'test' ? `pi-channels test: ${new Date().toISOString()}` : params.text;

      const message: ChannelMessage = {
        adapter: adapterName.value,
        recipient: params.recipient ?? '',
        payloadMode: params.payloadMode ?? (params.json ? 'raw' : 'envelope'),
        ...(Object.keys(webhook).length > 0 ? { webhook } : {}),
      };
      if (text !== undefined) message.text = text;
      if (params.action === 'test') message.source = 'channel:test';
      else if (params.source !== undefined) message.source = params.source;
      if (rawBody !== undefined) message.rawBody = rawBody;
      const result = await registry.send(message);
      return textToolResult(
        result.ok
          ? `Sent via "${adapterName.value}"${params.recipient ? ` to ${params.recipient}` : ''}.`
          : `Failed: ${result.error}`,
      );
    },
  });

  pi.events.on('channel:send', (raw: unknown) => {
    const data = raw as ChannelMessage & {
      callback?: (result: { ok: boolean; error?: string }) => void;
    };
    const { callback, ...message } = data;
    registry.send(message).then((result) => callback?.(result));
  });

  pi.events.on('channel:register', (raw: unknown) => {
    const data = raw as {
      name?: string;
      adapter?: ChannelAdapter;
      callback?: (ok: boolean) => void;
    };
    if (!data.name || !data.adapter) {
      data.callback?.(false);
      return;
    }
    registry.register(data.name, data.adapter);
    data.callback?.(true);
  });

  pi.events.on('channel:remove', (raw: unknown) => {
    const data = raw as { name?: string; callback?: (ok: boolean) => void };
    data.callback?.(data.name ? registry.unregister(data.name) : false);
  });

  pi.events.on('channel:list', (raw: unknown) => {
    const data = raw as { callback?: (items: ReturnType<ChannelRegistry['list']>) => void };
    data.callback?.(registry.list());
  });

  pi.events.on('channel:status', (raw: unknown) => {
    const data = raw as {
      callback?: (result: {
        ok: boolean;
        active: boolean;
        cwd?: string;
        connectedAt?: string;
        error?: string;
        errors: Array<{ adapter: string; error: string }>;
        items: ReturnType<ChannelRegistry['list']>;
        bridgeActive: boolean;
        adapterStates: Record<string, AdapterConnectionState>;
      }) => void;
    };
    const errors = registry.getErrors();
    const error = errors.map((item) => `${item.adapter}: ${item.error}`).join('; ') || lastError;
    data.callback?.({
      ok: Boolean(currentCtx) && errors.length === 0 && !lastError,
      active: Boolean(currentCtx),
      ...(currentCtx ? { cwd: sessionCwd } : {}),
      ...(connectedAt ? { connectedAt } : {}),
      ...(error ? { error } : {}),
      errors,
      items: registry.list(),
      bridgeActive: Boolean(bridge?.isActive()),
      adapterStates,
    });
  });

  pi.events.on('channel:capture', (raw: unknown) => {
    const data = raw as {
      adapter?: unknown;
      captureToken?: unknown;
      timeoutMs?: unknown;
      callback?: (result: { ok: boolean; message?: IncomingMessage; error?: string }) => void;
    };
    if (!currentCtx) {
      data.callback?.({ ok: false, error: 'pi-channels session is not active.' });
      return;
    }
    const adapter = typeof data.adapter === 'string' ? data.adapter.trim() : '';
    if (!adapter) {
      data.callback?.({ ok: false, error: 'adapter is required' });
      return;
    }
    const timeoutMs =
      typeof data.timeoutMs === 'number' && Number.isFinite(data.timeoutMs)
        ? Math.max(5_000, Math.min(120_000, Math.floor(data.timeoutMs)))
        : 60_000;
    const captureToken =
      typeof data.captureToken === 'string' && data.captureToken.trim()
        ? data.captureToken.trim()
        : undefined;
    let waiter: CaptureWaiter;
    const cleanup = () => {
      clearTimeout(waiter.timer);
      captureWaiters.delete(waiter);
    };
    waiter = {
      adapter,
      ...(captureToken ? { captureToken } : {}),
      callback: (result) => {
        cleanup();
        data.callback?.(result);
      },
      timer: setTimeout(() => {
        cleanup();
        data.callback?.({
          ok: false,
          error: `等待群消息超时，请在 ${Math.round(timeoutMs / 1000)} 秒内给机器人发送消息`,
        });
      }, timeoutMs),
    };
    captureWaiters.add(waiter);
  });

  pi.events.on('channel:reload', (raw: unknown) => {
    const data = raw as {
      reason?: string;
      force?: boolean;
      cwd?: unknown;
      callback?: (result: { ok: boolean; error?: string }) => void;
    };
    const ctx = currentCtx ?? channelContextFromReload(data);
    if (!ctx) {
      data.callback?.({ ok: false, error: 'pi-channels session is not active.' });
      return;
    }
    currentCtx = ctx;
    sessionCwd = ctx.cwd;
    void applyChannelConfig(ctx, data.reason ?? 'event', data.force !== false)
      .then((errors) =>
        data.callback?.(
          errors.length > 0
            ? {
                ok: false,
                error: errors.map((item) => `${item.adapter}: ${item.error}`).join('; '),
              }
            : { ok: true },
        ),
      )
      .catch((error) => {
        data.callback?.({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  function notifyCaptureWaiters(message: IncomingMessage): boolean {
    let captured = false;
    for (const waiter of [...captureWaiters]) {
      if (waiter.adapter !== message.adapter) continue;
      if (waiter.captureToken && !message.text.includes(waiter.captureToken)) continue;
      captured = true;
      waiter.callback({ ok: true, message });
    }
    return captured;
  }

  function rejectCaptureWaiters(error: string): void {
    for (const waiter of [...captureWaiters]) {
      waiter.callback({ ok: false, error });
    }
  }

  function scheduleReconnect(event: string, error: string): void {
    const ctx = currentCtx;
    if (!ctx || reconnectTimer) return;
    clearReconnectResetTimer();
    const nextAttempt = reconnectAttempts + 1;
    if (nextAttempt > RECONNECT_DELAYS_MS.length) {
      log('channel_reconnect_exhausted', { event, error, attempts: reconnectAttempts }, 'WARN');
      return;
    }
    reconnectAttempts = nextAttempt;
    const delayMs = RECONNECT_DELAYS_MS[nextAttempt - 1] ?? RECONNECT_DELAYS_MS.at(-1)!;
    log('channel_reconnect_scheduled', { event, error, attempt: nextAttempt, delayMs }, 'WARN');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      const activeCtx = currentCtx;
      if (!activeCtx) return;
      void applyChannelConfig(activeCtx, 'reconnect', true).catch((reconnectError) => {
        log(
          'channel_reconnect_failed',
          {
            attempt: nextAttempt,
            error:
              reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          },
          'ERROR',
        );
      });
    }, delayMs);
  }

  function scheduleReconnectAttemptReset(): void {
    clearReconnectResetTimer();
    reconnectResetTimer = setTimeout(() => {
      reconnectAttempts = 0;
      reconnectResetTimer = undefined;
    }, RECONNECT_STABLE_RESET_MS);
  }

  function clearReconnectTimers(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearReconnectResetTimer();
  }

  function clearReconnectResetTimer(): void {
    if (reconnectResetTimer) clearTimeout(reconnectResetTimer);
    reconnectResetTimer = undefined;
  }
}

function channelContextFromReload(data: { cwd?: unknown }): ChannelRuntimeContext | null {
  const cwd = typeof data.cwd === 'string' && data.cwd.trim() ? data.cwd.trim() : '';
  if (!cwd) return null;
  return {
    cwd,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
  };
}

function sessionAutostartDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_CHANNELS_DISABLE_SESSION_AUTOSTART ?? '');
}

function adapterStatesForRegistry(
  config: ChannelConfig,
  errors: Array<{ adapter: string; error: string }>,
  connectedAt: string | undefined,
): Record<string, AdapterConnectionState> {
  const updatedAt = new Date().toISOString();
  const errorsByAdapter = new Map(errors.map((error) => [error.adapter, error.error]));
  return Object.fromEntries(
    Object.keys(config.adapters ?? {}).map((adapter) => {
      const error = errorsByAdapter.get(adapter);
      return [
        adapter,
        error
          ? { state: 'error', updatedAt, error }
          : {
              state: 'connected',
              updatedAt,
              ...(connectedAt ? { connectedAt } : {}),
            },
      ] satisfies [string, AdapterConnectionState];
    }),
  );
}

function channelIncomingTurn(message: IncomingMessage):
  | {
      sessionId: string;
      adapter: string;
      recipient: string;
      userMessage: string;
      title: string;
      createdAt: string;
    }
  | undefined {
  const text = message.text.trim();
  if (!text) return undefined;
  const sessionId = recipientFromIncoming(message);
  if (!sessionId) return undefined;
  return {
    sessionId,
    adapter: message.adapter,
    recipient: sessionId,
    userMessage: text,
    title: displayNameFromIncoming(message) ?? sessionId,
    createdAt: new Date().toISOString(),
  };
}

function autoFillEmptyRouteRecipient(
  cwd: string,
  message: { adapter: string; sender: string; metadata?: Record<string, unknown> },
  log: (event: string, data?: Record<string, unknown>, level?: string) => void,
): void {
  const recipient = recipientFromIncoming(message);
  if (!recipient) return;
  const displayName = displayNameFromIncoming(message);

  try {
    let filledRoute: string | undefined;
    const updated = updateLocalChannelConfig(cwd, (config) => {
      const routes = config.routes ?? {};
      const fillableRoutes = Object.entries(routes).filter(
        ([, route]) => route.adapter === message.adapter && !trimToUndefined(route.recipient),
      );
      const captureRoutes = fillableRoutes.filter(([, route]) => route.capture === true);
      const routesToFill = captureRoutes.length > 0 ? captureRoutes : fillableRoutes;
      if (routesToFill.length !== 1) return config;

      const [routeName, route] = routesToFill[0]!;
      filledRoute = routeName;
      return {
        ...config,
        routes: {
          ...routes,
          [routeName]: {
            ...route,
            recipient,
            capture: false,
            ...(displayName && !trimToUndefined(route.name) ? { name: displayName } : {}),
          },
        },
      } satisfies ChannelConfig;
    });

    if (updated && filledRoute) {
      log('route_recipient_auto_filled', {
        route: filledRoute,
        adapter: message.adapter,
        recipient,
      });
    }
  } catch (error) {
    log(
      'route_recipient_auto_fill_failed',
      {
        adapter: message.adapter,
        error: error instanceof Error ? error.message : String(error),
      },
      'ERROR',
    );
  }
}

function displayNameFromIncoming(message: {
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadata = message.metadata ?? {};
  return trimToUndefined(
    typeof metadata.chatName === 'string'
      ? metadata.chatName
      : typeof metadata.groupName === 'string'
        ? metadata.groupName
        : undefined,
  );
}

function recipientFromIncoming(message: {
  adapter: string;
  sender: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadata = message.metadata ?? {};
  if (message.adapter === 'feishu') {
    return trimToUndefined(typeof metadata.chatId === 'string' ? metadata.chatId : undefined);
  }
  if (message.adapter === 'wecom') {
    return (
      firstStringMetadata(metadata, ['chatId', 'groupId', 'conversationId', 'roomId']) ??
      trimToUndefined(message.sender.split(':')[0])
    );
  }
  return trimToUndefined(message.sender);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstStringMetadata(
  metadata: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    const trimmed = trimToUndefined(typeof value === 'string' ? value : undefined);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function emptyListMessage(action: NotifyParams['action']): string {
  if (action === 'list-adapters') return 'No channel adapters configured.';
  if (action === 'list-routes') return 'No channel routes configured.';
  return 'No channels configured.';
}

function normalizeAdapterName(
  value: string,
  items: ReturnType<ChannelRegistry['list']>,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  const routeSelector = /^@?local:channels_([\w.-]+):([\w.-]+)$/.exec(trimmed);
  if (routeSelector) {
    const adapterName = routeSelector[1]!;
    const routeName = routeSelector[2]!;
    const route = items.find((item) => item.type === 'route' && item.name === routeName);
    if (route) {
      if (route.adapter && route.adapter !== adapterName) {
        return {
          ok: false,
          error: `Channel route "${routeName}" uses adapter "${route.adapter}", not "${adapterName}".`,
        };
      }
      return { ok: true, value: route.name };
    }
    const routes = items.filter((item) => item.type === 'route');
    return {
      ok: false,
      error: routes.length
        ? `Unknown channel route "${routeName}". Use one of: ${routes
            .map((item) => `local:channels_${item.adapter ?? 'adapter'}:${item.name}`)
            .join(', ')}.`
        : `Unknown channel route "${routeName}". No routes are configured.`,
    };
  }
  if (/^@?local:channels[:/][\w.-]+$/.test(trimmed)) {
    return {
      ok: false,
      error:
        'Channel route mentions must include the provider, for example @local:channels_wecom:ops.',
    };
  }
  if (trimmed !== '@local:channels' && trimmed !== 'local:channels') {
    return { ok: true, value: trimmed };
  }

  const routes = items.filter((item) => item.type === 'route');
  if (routes.length > 0) {
    return {
      ok: false,
      error: `@local:channels selects the plugin, not a route. Use one of these channel route mentions: ${routes
        .map((item) => `@local:channels_${item.adapter ?? 'adapter'}:${item.name}`)
        .join(', ')}.`,
    };
  }

  const adapters = items.filter((item) => item.type === 'adapter');
  if (adapters.length === 1) {
    return {
      ok: false,
      error: `@local:channels selects the plugin, not a recipient. Use adapter "${adapters[0]!.name}" with a recipient.`,
    };
  }
  return {
    ok: false,
    error:
      '@local:channels selects the plugin, not a send target. Run notify with action "list" and use an adapter name or route alias.',
  };
}

function textToolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: undefined;
} {
  return { content: [{ type: 'text', text }], details: undefined };
}
