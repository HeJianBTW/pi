import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ChatBridge } from './bridge.js';
import { loadChannelConfig } from './config.js';
import { ChannelRegistry } from './registry.js';
import type { ChannelAdapter, ChannelMessage } from './types.js';

type NotifyParams = {
  action: 'send' | 'list' | 'test';
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

  const log = (event: string, data?: Record<string, unknown>, level = 'INFO') => {
    if (level === 'ERROR') console.error('[pi-channels]', event, data ?? {});
    else console.debug('[pi-channels]', event, data ?? {});
  };
  registry.setLogger(log);

  registry.setOnIncoming(async (message) => {
    pi.events.emit('channel:receive', message);
    if (bridge?.isActive()) await bridge.handleMessage(message);
  });

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    const config = loadChannelConfig(ctx.cwd);
    await registry.loadConfig(config, ctx.cwd);
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
                  ? `${item.name} route -> ${item.target}`
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
      'Send messages through configured pi channels. Supports native Feishu, WeCom, and webhooks.',
    parameters: Type.Object({
      action: enumSchema(['send', 'list', 'test'], 'Action to perform') as never,
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
      if (params.action === 'list') {
        const items = registry.list();
        return {
          content: [
            {
              type: 'text' as const,
              text: items.length
                ? items
                    .map((item) =>
                      item.type === 'route'
                        ? `- ${item.name} route -> ${item.target}`
                        : `- ${item.name} adapter (${item.direction})`,
                    )
                    .join('\n')
                : 'No channels configured.',
            },
          ],
          details: undefined,
        };
      }

      if (!params.adapter) return textToolResult('Missing required field: adapter.');

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
        adapter: params.adapter,
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
          ? `Sent via "${params.adapter}"${params.recipient ? ` to ${params.recipient}` : ''}.`
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

function textToolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  details: undefined;
} {
  return { content: [{ type: 'text', text }], details: undefined };
}
