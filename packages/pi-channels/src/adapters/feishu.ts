import { createServer, type Server } from 'node:http';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  AdapterConfig,
  ChannelAdapter,
  ChannelMessage,
  FeishuAdapterConfig,
  OnIncomingMessage,
} from '../types.js';

type ReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';
type FeishuEventMode = 'websocket' | 'http' | 'off';

type RawFeishuMessageEvent = {
  event_id?: string;
  tenant_key?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name?: string;
      tenant_key?: string;
    }>;
  };
};

type ParsedTextContent = {
  text: string;
};

type IncomingMention = {
  key?: string;
  name?: string;
  isBot?: boolean;
  openId?: string;
  userId?: string;
  id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
};

function asConfig(config: AdapterConfig): FeishuAdapterConfig {
  return config as FeishuAdapterConfig;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`Feishu adapter requires ${name}`);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseTextContent(content: string): ParsedTextContent {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return { text: typeof parsed.text === 'string' ? parsed.text : '' };
  } catch {
    return { text: content };
  }
}

function normalizeFeishuIncomingText(
  text: string,
  mentions: IncomingMention[] | undefined,
  cfg: FeishuAdapterConfig,
  mentionedBot: boolean,
): string {
  let cleaned = text.replace(/\u00a0/g, ' ').trim();
  cleaned = cleaned.replace(/^回复\s+[^:：]{1,80}[:：]\s*/u, '').trim();

  if (mentions?.length) {
    const botMentions = mentions.filter((mention) => isBotMention(mention, cfg));
    const leadingMentions = botMentions.length > 0 ? botMentions : mentionedBot ? mentions : [];
    cleaned = stripLeadingMentionTokens(cleaned, mentionTokens(leadingMentions));
  }

  if (mentionedBot) {
    cleaned = cleaned.replace(/^@[\p{L}\p{N}_\-.·]+(?:\s+|$)/u, '').trim();
  }

  return cleaned;
}

function isBotMention(mention: IncomingMention, cfg: FeishuAdapterConfig): boolean {
  if (mention.isBot) return true;
  const botOpenId = optionalNonEmptyString(cfg.botOpenId);
  if (!botOpenId) return false;
  return (
    mention.openId === botOpenId ||
    mention.userId === botOpenId ||
    mention.id?.open_id === botOpenId ||
    mention.id?.user_id === botOpenId ||
    mention.id?.union_id === botOpenId
  );
}

function mentionTokens(mentions: IncomingMention[]): string[] {
  const tokens = new Set<string>();
  for (const mention of mentions) {
    if (mention.key?.trim()) tokens.add(mention.key.trim());
    if (mention.name?.trim()) tokens.add(`@${mention.name.trim()}`);
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

function stripLeadingMentionTokens(text: string, tokens: string[]): string {
  let cleaned = text.trimStart();
  for (let i = 0; i < 8; i++) {
    const next = stripOneLeadingMentionToken(cleaned, tokens);
    if (next === cleaned) break;
    cleaned = next.trimStart();
  }
  return cleaned.trim();
}

function stripOneLeadingMentionToken(text: string, tokens: string[]): string {
  for (const token of tokens) {
    if (text === token) return '';
    if (text.startsWith(token) && /\s/u.test(text[token.length] ?? '')) {
      return text.slice(token.length);
    }
  }
  return text;
}

function resolveReceiveId(
  message: ChannelMessage,
  defaultType: ReceiveIdType,
): {
  receiveIdType: ReceiveIdType;
  receiveId: string;
} {
  const match = message.recipient.match(/^(chat_id|open_id|user_id|union_id|email):(.+)$/);
  if (!match) return { receiveIdType: defaultType, receiveId: message.recipient };
  return { receiveIdType: match[1] as ReceiveIdType, receiveId: match[2]! };
}

function resolveDomain(value: unknown): lark.Domain | string | undefined {
  if (!value) return undefined;
  if (value === 'feishu') return lark.Domain.Feishu;
  if (value === 'lark') return lark.Domain.Lark;
  if (typeof value === 'string') return value;
  return undefined;
}

function resolveAppType(value: unknown): lark.AppType | undefined {
  if (value === 'isv' || value === 'ISV') return lark.AppType.ISV;
  if (value === 'self_build' || value === 'selfBuild' || value === 'SelfBuild') {
    return lark.AppType.SelfBuild;
  }
  return undefined;
}

function resolveLoggerLevel(value: unknown): lark.LoggerLevel {
  if (value === 'debug') return lark.LoggerLevel.debug;
  if (value === 'info') return lark.LoggerLevel.info;
  if (value === 'warn') return lark.LoggerLevel.warn;
  if (value === 'trace') return lark.LoggerLevel.trace;
  return lark.LoggerLevel.error;
}

function createSdkLogger(
  log: ((event: string, data?: Record<string, unknown>, level?: string) => void) | undefined,
) {
  const emit = (level: string, msg: unknown[]) => {
    log?.('feishu-sdk', { message: msg.map(String).join(' ') }, level);
  };
  return {
    error: (...msg: unknown[]) => emit('ERROR', msg),
    warn: (...msg: unknown[]) => emit('WARN', msg),
    info: (...msg: unknown[]) => emit('INFO', msg),
    debug: (...msg: unknown[]) => emit('DEBUG', msg),
    trace: (...msg: unknown[]) => emit('TRACE', msg),
  };
}

function shouldAcceptMessage(
  msg: {
    chatId: string;
    senderId: string;
    chatType: string;
    mentionedBot: boolean;
  },
  cfg: FeishuAdapterConfig,
): boolean {
  const allowedChatIds = cfg.allowedChatIds;
  if (
    Array.isArray(allowedChatIds) &&
    allowedChatIds.length > 0 &&
    !allowedChatIds.includes(msg.chatId)
  ) {
    return false;
  }

  const allowedSenderIds = cfg.allowedSenderIds;
  if (
    Array.isArray(allowedSenderIds) &&
    allowedSenderIds.length > 0 &&
    !allowedSenderIds.includes(msg.senderId)
  ) {
    return false;
  }

  if ((cfg.respondToMentionsOnly ?? true) && msg.chatType === 'group' && !msg.mentionedBot) {
    return false;
  }

  return true;
}

function senderForMessage(chatId: string, threadId: string | undefined): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

function objectStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

export function createFeishuAdapter(
  config: AdapterConfig,
  context: {
    log?: (event: string, data?: Record<string, unknown>, level?: string) => void;
  } = {},
): ChannelAdapter {
  const cfg = asConfig(config);
  const appId = requireString(cfg.appId, 'appId');
  const appSecret = requireString(cfg.appSecret, 'appSecret');
  const defaultReceiveIdType = cfg.receiveIdType ?? 'chat_id';
  const eventMode = resolveEventMode(cfg);
  const logger = createSdkLogger(context.log);
  const loggerLevel = resolveLoggerLevel(cfg.loggerLevel);
  const domain = resolveDomain(cfg.domain);
  const appType = resolveAppType(cfg.appType);

  const client = new lark.Client({
    appId,
    appSecret,
    logger,
    loggerLevel,
    source: 'amaster-pi-channels',
    ...(domain !== undefined ? { domain } : {}),
    ...(appType !== undefined ? { appType } : {}),
  });

  let channel: lark.LarkChannel | null = null;
  let server: Server | null = null;

  async function resolveChatName(chatId: string): Promise<string | undefined> {
    const chatApi = (client.im as unknown as {
      chat?: {
        get?: (args: { path: { chat_id: string } }) => Promise<unknown>;
      };
    }).chat;
    if (!chatApi?.get) return undefined;
    try {
      const response = await chatApi.get({ path: { chat_id: chatId } });
      const code = (response as { code?: unknown }).code;
      if (code !== undefined && code !== 0) return undefined;
      const data = (response as { data?: unknown }).data;
      const chat = data && typeof data === 'object' ? (data as Record<string, unknown>).chat : undefined;
      return (
        objectStringField(data, 'name') ??
        objectStringField(chat, 'name') ??
        objectStringField(data, 'chat_name') ??
        objectStringField(chat, 'chat_name')
      );
    } catch (error) {
      context.log?.(
        'feishu-chat-name-fetch-failed',
        { chatId, error: error instanceof Error ? error.message : String(error) },
        'WARN',
      );
      return undefined;
    }
  }

  async function sendText(message: ChannelMessage): Promise<void> {
    if (!message.text) throw new Error('Feishu adapter requires text');
    const text = message.source ? `[${message.source}]\n${message.text}` : message.text;

    const replyToMessageId =
      typeof message.metadata?.messageId === 'string'
        ? message.metadata.messageId
        : typeof message.metadata?.replyToMessageId === 'string'
          ? message.metadata.replyToMessageId
          : undefined;
    if (replyToMessageId) {
      const response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: cfg.replyInThread ?? Boolean(message.metadata?.threadId),
        },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu reply error: ${response.msg ?? response.code ?? 'unknown'}`);
      }
      return;
    }

    const { receiveIdType, receiveId } = resolveReceiveId(message, defaultReceiveIdType);
    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu send error: ${response.msg ?? response.code ?? 'unknown'}`);
    }
  }

  async function handleNormalizedMessage(
    msg: lark.NormalizedMessage,
    onMessage: OnIncomingMessage,
  ): Promise<void> {
    if (
      !shouldAcceptMessage(
        {
          chatId: msg.chatId,
          senderId: msg.senderId,
          chatType: msg.chatType,
          mentionedBot: msg.mentionedBot,
        },
        cfg,
      )
    ) {
      return;
    }

    if (msg.rawContentType !== 'text' && msg.rawContentType !== 'post') return;
    const text = normalizeFeishuIncomingText(msg.content, msg.mentions, cfg, msg.mentionedBot);
    if (!text) return;
    const chatName = await resolveChatName(msg.chatId);

    void onMessage({
      adapter: 'feishu',
      sender: senderForMessage(msg.chatId, msg.threadId),
      text,
      metadata: {
        messageId: msg.messageId,
        chatId: msg.chatId,
        ...(chatName ? { chatName } : {}),
        chatType: msg.chatType,
        senderId: msg.senderId,
        senderName: msg.senderName,
        threadId: msg.threadId,
        rootId: msg.rootId,
        replyToMessageId: msg.replyToMessageId,
        messageIdForReply: msg.messageId,
        rawContentType: msg.rawContentType,
      },
    });
  }

  function handleRawMessage(data: RawFeishuMessageEvent, onMessage: OnIncomingMessage): void {
    if (data.message.message_type !== 'text') return;
    const parsed = parseTextContent(data.message.content);
    const senderId =
      data.sender.sender_id?.open_id ??
      data.sender.sender_id?.user_id ??
      data.sender.sender_id?.union_id ??
      '';
    const mentionedBot =
      !cfg.botOpenId ||
      (data.message.mentions ?? []).some(
        (mention) =>
          mention.id.open_id === cfg.botOpenId ||
          mention.id.user_id === cfg.botOpenId ||
          mention.id.union_id === cfg.botOpenId,
      );

    if (
      !shouldAcceptMessage(
        {
          chatId: data.message.chat_id,
          senderId,
          chatType: data.message.chat_type,
          mentionedBot,
        },
        cfg,
      )
    ) {
      return;
    }

    const text = normalizeFeishuIncomingText(
      parsed.text,
      data.message.mentions,
      cfg,
      mentionedBot,
    );
    if (!text) return;

    void onMessage({
      adapter: 'feishu',
      sender: senderForMessage(data.message.chat_id, data.message.thread_id),
      text,
      metadata: {
        eventId: data.event_id,
        tenantKey: data.tenant_key,
        messageId: data.message.message_id,
        replyToMessageId: data.message.message_id,
        chatId: data.message.chat_id,
        chatType: data.message.chat_type,
        threadId: data.message.thread_id,
        rootId: data.message.root_id,
        senderId: data.sender.sender_id,
      },
    });
  }

  async function start(onMessage: OnIncomingMessage): Promise<void> {
    if (eventMode === 'off') return;

    if (eventMode === 'websocket') {
      if (channel) return;
      channel = lark.createLarkChannel({
        appId,
        appSecret,
        transport: 'websocket',
        logger,
        loggerLevel,
        source: 'amaster-pi-channels',
        includeRawEvent: true,
        ...(domain !== undefined ? { domain } : {}),
        policy: {
          requireMention: cfg.respondToMentionsOnly ?? true,
          respondToMentionAll: cfg.respondToMentionAll ?? false,
          ...(Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.length > 0
            ? { groupAllowlist: cfg.allowedChatIds }
            : {}),
          ...(cfg.dmMode ? { dmMode: cfg.dmMode } : {}),
          ...(Array.isArray(cfg.dmAllowlist) && cfg.dmAllowlist.length > 0
            ? { dmAllowlist: cfg.dmAllowlist }
            : {}),
        },
        ...(cfg.handshakeTimeoutMs ? { handshakeTimeoutMs: cfg.handshakeTimeoutMs } : {}),
        ...(cfg.wsPingTimeoutSeconds
          ? { wsConfig: { pingTimeout: cfg.wsPingTimeoutSeconds } }
          : {}),
      });
      channel.on('message', (msg) => {
        void handleNormalizedMessage(msg, onMessage);
      });
      channel.on('error', (error) => {
        context.log?.('feishu-channel-error', { error: error.message, code: error.code }, 'ERROR');
      });
      await channel.connect();
      return;
    }

    if (server) return;
    const incoming = cfg.incoming ?? {};
    const host = incoming.host ?? '0.0.0.0';
    const port = incoming.port ?? 8787;
    const path = incoming.path ?? '/feishu/events';
    const dispatcher = new lark.EventDispatcher({
      logger,
      loggerLevel,
      ...(optionalNonEmptyString(cfg.verificationToken)
        ? { verificationToken: cfg.verificationToken }
        : {}),
      ...(optionalNonEmptyString(cfg.encryptKey) ? { encryptKey: cfg.encryptKey } : {}),
    }).register({
      'im.message.receive_v1': async (data: RawFeishuMessageEvent) => {
        handleRawMessage(data, onMessage);
      },
    });
    const handler = lark.adaptDefault(path, dispatcher, { autoChallenge: true });
    server = createServer((request, response) => {
      void handler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, host, () => {
        server!.off('error', reject);
        resolve();
      });
    });
  }

  return {
    direction: eventMode === 'off' ? 'outgoing' : 'bidirectional',
    send: sendText,
    start,
    async stop(): Promise<void> {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
  };
}

function resolveEventMode(cfg: FeishuAdapterConfig): FeishuEventMode {
  if (cfg.eventMode === 'http' || cfg.eventMode === 'websocket' || cfg.eventMode === 'off') {
    return cfg.eventMode;
  }
  if (cfg.incoming?.enabled) return 'http';
  return 'websocket';
}
