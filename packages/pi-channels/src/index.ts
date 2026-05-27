import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ChatBridge } from './bridge.js';
import { loadChannelConfig, updateLocalChannelConfig } from './config.js';
import { ChannelRegistry } from './registry.js';
import type { ChannelAdapter, ChannelConfig, ChannelMessage } from './types.js';

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

  const log = (event: string, data?: Record<string, unknown>, level = 'INFO') => {
    if (level === 'ERROR') console.error('[pi-channels]', event, data ?? {});
    else console.debug('[pi-channels]', event, data ?? {});
  };
  registry.setLogger(log);

  registry.setOnIncoming(async (message) => {
    pi.events.emit('channel:receive', message);
    autoFillEmptyRouteRecipient(sessionCwd, message, log);
    if (bridge?.isActive()) await bridge.handleMessage(message);
  });

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    const config = loadChannelConfig(ctx.cwd);
    await registry.loadConfig(config, ctx.cwd);
    log('session_start', {
      cwd: ctx.cwd,
      adapters: Object.keys(config.adapters ?? {}),
      routes: Object.keys(config.routes ?? {}),
      registry: registry.list(),
    });
    await registry.startListening();

    bridge = new ChatBridge(config.bridge, ctx.cwd, registry);
    if (config.bridge?.enabled) bridge.start();

    const errors = registry.getErrors();
    for (const error of errors) {
      ctx.ui.notify(`pi-channels: ${error.adapter}: ${error.error}`, 'warning');
    }
    ctx.ui.setStatus?.(
      'pi-channels',
      `channels: ${registry.list().filter((item) => item.type === 'adapter').length}`,
    );
  });

  pi.on('session_shutdown', async (_event: unknown, ctx: ExtensionContext) => {
    bridge?.stop();
    bridge = null;
    await registry.stopAll();
    ctx.ui.setStatus?.('pi-channels', undefined);
  });

  pi.registerCommand('channel', {
    description: 'Manage pi channels: /channel [list|bridge on|bridge off|bridge status]',
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
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
      'Send messages through configured pi channels. Supports native Feishu, WeCom, and webhooks. Use configured adapter names or route aliases. A chat mention such as @local:channels:ops means route alias "ops"; @local:channels alone selects the plugin, not a send target.',
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
    return trimToUndefined(message.sender);
  }
  return trimToUndefined(message.sender);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
  const routeSelector = /^@?local:channels[:/]([\w.-]+)$/.exec(trimmed);
  if (routeSelector) {
    const routeName = routeSelector[1]!;
    const route = items.find((item) => item.type === 'route' && item.name === routeName);
    if (route) return { ok: true, value: route.name };
    const routes = items.filter((item) => item.type === 'route');
    return {
      ok: false,
      error: routes.length
        ? `Unknown channel route "${routeName}". Use one of: ${routes
            .map((item) => item.name)
            .join(', ')}.`
        : `Unknown channel route "${routeName}". No routes are configured.`,
    };
  }
  if (trimmed !== '@local:channels' && trimmed !== 'local:channels') {
    return { ok: true, value: trimmed };
  }

  const routes = items.filter((item) => item.type === 'route');
  if (routes.length === 1) {
    return { ok: true, value: routes[0]!.name };
  }
  if (routes.length > 1) {
    return {
      ok: false,
      error: `@local:channels selects the plugin, not a route. Use one of these route aliases: ${routes
        .map((item) => item.name)
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
