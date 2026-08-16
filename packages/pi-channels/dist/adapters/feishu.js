import { createServer } from 'node:http';

import { join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
function asConfig(config) {
    return config;
}
function requireString(value, name) {
    if (typeof value === 'string' && value.trim())
        return value;
    throw new Error(`Feishu adapter requires ${name}`);
}
function optionalNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function parseTextContent(content) {
    try {
        const parsed = JSON.parse(content);
        return { text: typeof parsed.text === 'string' ? parsed.text : '' };
    }
    catch {
        return { text: content };
    }
}
function normalizeFeishuIncomingText(text, mentions, cfg, mentionedBot) {
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
function isBotMention(mention, cfg) {
    if (mention.isBot)
        return true;
    const botOpenId = optionalNonEmptyString(cfg.botOpenId);
    if (!botOpenId)
        return false;
    return (mention.openId === botOpenId ||
        mention.userId === botOpenId ||
        mention.id?.open_id === botOpenId ||
        mention.id?.user_id === botOpenId ||
        mention.id?.union_id === botOpenId);
}
function mentionTokens(mentions) {
    const tokens = new Set();
    for (const mention of mentions) {
        if (mention.key?.trim())
            tokens.add(mention.key.trim());
        if (mention.name?.trim())
            tokens.add(`@${mention.name.trim()}`);
    }
    return [...tokens].sort((a, b) => b.length - a.length);
}
function stripLeadingMentionTokens(text, tokens) {
    let cleaned = text.trimStart();
    for (let i = 0; i < 8; i++) {
        const next = stripOneLeadingMentionToken(cleaned, tokens);
        if (next === cleaned)
            break;
        cleaned = next.trimStart();
    }
    return cleaned.trim();
}
function stripOneLeadingMentionToken(text, tokens) {
    for (const token of tokens) {
        if (text === token)
            return '';
        if (text.startsWith(token) && /\s/u.test(text[token.length] ?? '')) {
            return text.slice(token.length);
        }
    }
    return text;
}
function resolveReceiveId(message, defaultType) {
    const match = message.recipient.match(/^(chat_id|open_id|user_id|union_id|email):(.+)$/);
    if (!match)
        return { receiveIdType: defaultType, receiveId: message.recipient };
    return { receiveIdType: match[1], receiveId: match[2] };
}
function resolveDomain(value) {
    if (!value)
        return undefined;
    if (value === 'feishu')
        return lark.Domain.Feishu;
    if (value === 'lark')
        return lark.Domain.Lark;
    if (typeof value === 'string')
        return value;
    return undefined;
}
function resolveAppType(value) {
    if (value === 'isv' || value === 'ISV')
        return lark.AppType.ISV;
    if (value === 'self_build' || value === 'selfBuild' || value === 'SelfBuild') {
        return lark.AppType.SelfBuild;
    }
    return undefined;
}
function resolveLoggerLevel(value) {
    if (value === 'debug')
        return lark.LoggerLevel.debug;
    if (value === 'info')
        return lark.LoggerLevel.info;
    if (value === 'warn')
        return lark.LoggerLevel.warn;
    if (value === 'trace')
        return lark.LoggerLevel.trace;
    return lark.LoggerLevel.error;
}
function createSdkLogger(log) {
    const emit = (level, msg) => {
        log?.('feishu-sdk', { message: msg.map(String).join(' ') }, level);
    };
    return {
        error: (...msg) => emit('ERROR', msg),
        warn: (...msg) => emit('WARN', msg),
        info: (...msg) => emit('INFO', msg),
        debug: (...msg) => emit('DEBUG', msg),
        trace: (...msg) => emit('TRACE', msg),
    };
}
function shouldAcceptMessage(msg, cfg) {
    const allowedChatIds = cfg.allowedChatIds;
    if (Array.isArray(allowedChatIds) &&
        allowedChatIds.length > 0 &&
        !allowedChatIds.includes(msg.chatId)) {
        return false;
    }
    const allowedSenderIds = cfg.allowedSenderIds;
    if (Array.isArray(allowedSenderIds) &&
        allowedSenderIds.length > 0 &&
        !allowedSenderIds.includes(msg.senderId)) {
        return false;
    }
    if ((cfg.respondToMentionsOnly ?? true) && msg.chatType === 'group' && !msg.mentionedBot) {
        return false;
    }
    return true;
}
function senderForMessage(chatId, threadId) {
    return threadId ? `${chatId}:${threadId}` : chatId;
}
function objectStringField(value, key) {
    if (!value || typeof value !== 'object')
        return undefined;
    const field = value[key];
    return typeof field === 'string' && field.trim() ? field : undefined;
}
function ackReactionEmoji(cfg) {
    if (cfg.ackReactionEmoji === false)
        return null;
    return optionalNonEmptyString(cfg.ackReactionEmoji) ?? 'OK';
}
export function reactionIdFromResponse(body) {
    return body?.data?.reaction_id ?? body?.reaction_id;
}
function imageMimeType(contentType) {
    const normalized = String(contentType ?? '').toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg'))
        return 'image/jpeg';
    if (normalized.includes('gif'))
        return 'image/gif';
    if (normalized.includes('webp'))
        return 'image/webp';
    return 'image/png';
}
function imageKeyFromMessageDetail(detail) {
    const items = detail?.data?.items ?? detail?.data?.data?.items ?? [];
    const content = items[0]?.body?.content ?? items[0]?.content ?? detail?.data?.body?.content ?? '';
    if (typeof content !== 'string')
        return undefined;
    try {
        const parsed = JSON.parse(content);
        return typeof parsed?.image_key === 'string' && parsed.image_key.trim()
            ? parsed.image_key.trim()
            : undefined;
    }
    catch {
        return undefined;
    }
}
function feishuErrorCode(error) {
    const candidates = [error?.code, error?.response?.data?.code, error?.response?.code, error?.data?.code];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' || (typeof candidate === 'string' && candidate.trim()))
            return String(candidate);
    }
    return undefined;
}
function formatFeishuImageError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = feishuErrorCode(error);
    return code ? `${message} (feishu_code=${code})` : message;
}
async function dataUrlFromFeishuResource(response) {
    if (response?.code !== undefined && response.code !== 0) {
        const error = new Error(response.msg ?? `Feishu resource download failed: ${response.code}`);
        error.code = response.code;
        throw error;
    }
    const chunks = [];
    for await (const chunk of response.getReadableStream())
        chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0)
        throw new Error('Feishu image download returned an empty body');
    return `data:${imageMimeType(response.headers?.['content-type'])};base64,${bytes.toString('base64')}`;
}
/**
 * Downloads a Feishu image from its owning message.
 *
 * The detail endpoint is deliberately consulted before downloading: a
 * normalized websocket event can carry a stale resource key, while
 * body.content.image_key is the canonical key documented by Feishu.
 */
export async function downloadFeishuImage({ client, messageId, eventImageKey, retryDelaysMs = [0, 1000, 3000, 7000], log }) {
    if (!client || !messageId)
        return { error: 'missing Feishu client or message ID', attempts: 0 };
    let canonicalKey;
    try {
        canonicalKey = imageKeyFromMessageDetail(await client.im.message.get({ path: { message_id: messageId } }));
    }
    catch (error) {
        log?.('feishu-image-detail-fetch-failed', { messageId, error: formatFeishuImageError(error) }, 'WARN');
    }
    const imageKeys = [...new Set([canonicalKey, eventImageKey].filter((key) => typeof key === 'string' && key.trim()))];
    if (imageKeys.length === 0)
        return { error: 'missing image_key in Feishu message', attempts: 0 };
    let attempts = 0;
    let lastError;
    for (const imageKey of imageKeys) {
        for (const delayMs of retryDelaysMs) {
            if (attempts > 0 && delayMs > 0)
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            attempts += 1;
            try {
                const response = await client.im.messageResource.get({
                    path: { message_id: messageId, file_key: imageKey },
                    params: { type: 'image' },
                });
                return {
                    imageDataUrl: await dataUrlFromFeishuResource(response),
                    imageKey,
                    attempts,
                };
            }
            catch (error) {
                lastError = formatFeishuImageError(error);
                log?.('feishu-image-download-failed', { messageId, imageKey, attempt: attempts, error: lastError }, 'WARN');
            }
        }
    }
    return { error: lastError ?? 'Feishu image download failed', attempts };
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    }));
    return results;
}

export class FeishuImageBatcher {
    pending = new Map();
    constructor({ windowMs = 3_000, maxImages = 9, concurrency = 3, download, onMessage }) {
        this.windowMs = windowMs;
        this.maxImages = maxImages;
        this.concurrency = concurrency;
        this.download = download;
        this.onMessage = onMessage;
    }
    add(message) {
        const senderKey = message.sender;
        let batch = this.pending.get(senderKey);
        if (!batch) {
            batch = { messages: [], timer: setTimeout(() => void this.flush(senderKey), this.windowMs) };
            this.pending.set(senderKey, batch);
        }
        else {
            clearTimeout(batch.timer);
            batch.timer = setTimeout(() => void this.flush(senderKey), this.windowMs);
        }
        batch.messages.push(message);
        if (batch.messages.length >= this.maxImages)
            void this.flush(senderKey);
    }
    async flush(senderKey) {
        const batch = this.pending.get(senderKey);
        if (!batch)
            return;
        this.pending.delete(senderKey);
        clearTimeout(batch.timer);
        const imageBatch = await mapWithConcurrency(batch.messages, this.concurrency, async (message) => {
            const result = await this.download(message);
            return { imageDataUrl: result.imageDataUrl, imageError: result.error };
        });
        const last = batch.messages.at(-1);
        if (last) {
            const imageBatchMessageIds = batch.messages
                .map((message) => message.metadata?.messageId)
                .filter((messageId) => typeof messageId === 'string');
            await this.onMessage({
                ...last,
                imageBatch,
                ...(imageBatchMessageIds.length > 0
                    ? { metadata: { ...last.metadata, imageBatchMessageIds } }
                    : {}),
            });
        }
    }
}
export function buildFeishuChannelOptions(config, { logger } = {}) {
    const cfg = asConfig(config);
    const appId = requireString(cfg.appId, 'appId');
    const appSecret = requireString(cfg.appSecret, 'appSecret');
    const loggerLevel = resolveLoggerLevel(cfg.loggerLevel);
    const domain = resolveDomain(cfg.domain);
    return {
        appId,
        appSecret,
        transport: 'websocket',
        logger,
        loggerLevel,
        source: 'amaster-pi-channels',
        includeRawEvent: true,
        // The SDK's default per-chat text debounce merges image events before
        // FeishuImageBatcher sees them, leaving only one image key to process.
        safety: { chatQueue: { enabled: false } },
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
    };
}
export function createFeishuAdapter(config, context = {}) {
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
    let channel = null;
    let server = null;
    const ackReactionIds = new Map();
    const imageBatcher = new FeishuImageBatcher({
        download: async (message) => downloadFeishuImage({
            client,
            messageId: message.metadata.messageId,
            eventImageKey: message.eventImageKey,
            log: context.log,
        }),
        onMessage: async (message) => context.onMessage?.(message),
    });
    const cardActionHandlers = new Set();
    function emitCardAction(evt) {
        for (const handler of [...cardActionHandlers]) {
            try {
                void handler(evt);
            }
            catch (error) {
                context.log?.('feishu-card-action-handler-error', {
                    error: error instanceof Error ? error.message : String(error),
                }, 'WARN');
            }
        }
    }
    async function resolveChatName(chatId) {
        const chatApi = client.im.chat;
        if (!chatApi?.get)
            return undefined;
        try {
            const response = await chatApi.get({ path: { chat_id: chatId } });
            const code = response.code;
            if (code !== undefined && code !== 0)
                return undefined;
            const data = response.data;
            const chat = data && typeof data === 'object' ? data.chat : undefined;
            return (objectStringField(data, 'name') ??
                objectStringField(chat, 'name') ??
                objectStringField(data, 'chat_name') ??
                objectStringField(chat, 'chat_name'));
        }
        catch (error) {
            context.log?.('feishu-chat-name-fetch-failed', { chatId, error: error instanceof Error ? error.message : String(error) }, 'WARN');
            return undefined;
        }
    }
    async function addReaction(messageId, emojiType) {
        if (!emojiType)
            return;
        try {
            const response = (await client.request({
                url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
                method: 'POST',
                data: {
                    reaction_type: {
                        emoji_type: emojiType,
                    },
                },
            }));
            const body = response.data;
            if (body?.code !== undefined && body.code !== 0) {
                context.log?.('feishu-ack-reaction-failed', { messageId, emojiType, code: body.code, msg: body.msg }, 'WARN');
                return;
            }
            const reactionId = reactionIdFromResponse(body);
            if (reactionId)
                ackReactionIds.set(messageId, reactionId);
            return reactionId;
        }
        catch (error) {
            context.log?.('feishu-ack-reaction-failed', { messageId, emojiType, error: error instanceof Error ? error.message : String(error) }, 'WARN');
        }
    }
    async function addAckReaction(messageId) {
        return addReaction(messageId, ackReactionEmoji(cfg));
    }
    async function setFinalReaction(messageIds, emojiType) {
        const ids = [...new Set(messageIds.filter((id) => typeof id === 'string' && id))];
        for (const messageId of ids) {
            const reactionId = ackReactionIds.get(messageId);
            if (reactionId) {
                try {
                    await client.request({
                        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
                        method: 'DELETE',
                    });
                    ackReactionIds.delete(messageId);
                }
                catch (error) {
                    context.log?.('feishu-final-reaction-remove-failed', { messageId, error: error instanceof Error ? error.message : String(error) }, 'WARN');
                    continue;
                }
            }
            await addReaction(messageId, emojiType);
        }
    }
    async function sendText(message) {
        if (!message.text)
            throw new Error('Feishu adapter requires text');
        const text = message.source ? `[${message.source}]\n${message.text}` : message.text;
        const replyToMessageId = typeof message.metadata?.messageId === 'string'
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
    async function handleNormalizedMessage(msg, onMessage) {
        if (!shouldAcceptMessage({
            chatId: msg.chatId,
            senderId: msg.senderId,
            chatType: msg.chatType,
            mentionedBot: msg.mentionedBot,
        }, cfg)) {
            return;
        }
        if (msg.rawContentType !== 'text' && msg.rawContentType !== 'post' && msg.rawContentType !== 'image')
            return;
        let text = normalizeFeishuIncomingText(msg.content, msg.mentions, cfg, msg.mentionedBot);
        if (msg.rawContentType === 'image')
            text = '[图片]';
        const sender = senderForMessage(msg.chatId, msg.threadId);
        if (msg.rawContentType === 'image') {
            const eventImageKey = (msg.resources ?? []).find((r) => r.type === 'image')?.fileKey;
            void addAckReaction(msg.messageId);
            imageBatcher.onMessage = onMessage;
            imageBatcher.add({
                adapter: 'feishu',
                sender,
                text: '[图片]',
                eventImageKey,
                metadata: {
                    messageId: msg.messageId,
                    chatId: msg.chatId,
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
            return;
        }
        if (!text)
            return;
        void addAckReaction(msg.messageId);
        const chatName = await resolveChatName(msg.chatId);
        void onMessage({
            adapter: 'feishu',
            sender,
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
    function handleRawMessage(data, onMessage) {
        if (data.message.message_type !== 'text')
            return;
        const parsed = parseTextContent(data.message.content);
        const senderId = data.sender.sender_id?.open_id ??
            data.sender.sender_id?.user_id ??
            data.sender.sender_id?.union_id ??
            '';
        const mentionedBot = !cfg.botOpenId ||
            (data.message.mentions ?? []).some((mention) => mention.id.open_id === cfg.botOpenId ||
                mention.id.user_id === cfg.botOpenId ||
                mention.id.union_id === cfg.botOpenId);
        if (!shouldAcceptMessage({
            chatId: data.message.chat_id,
            senderId,
            chatType: data.message.chat_type,
            mentionedBot,
        }, cfg)) {
            return;
        }
        const text = normalizeFeishuIncomingText(parsed.text, data.message.mentions, cfg, mentionedBot);
        if (!text)
            return;
        void addAckReaction(data.message.message_id);
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
    async function start(onMessage) {
        if (eventMode === 'off')
            return;
        if (eventMode === 'websocket') {
            if (channel)
                return;
            channel = lark.createLarkChannel(buildFeishuChannelOptions(cfg, { logger }));
            channel.on('message', (msg) => {
                void handleNormalizedMessage(msg, onMessage);
            });
            channel.on('cardAction', (evt) => {
                emitCardAction(evt);
            });
            channel.on('error', (error) => {
                context.log?.('feishu-channel-error', { error: error.message, code: error.code }, 'ERROR');
            });
            await channel.connect();
            return;
        }
        if (server)
            return;
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
            'im.message.receive_v1': async (data) => {
                handleRawMessage(data, onMessage);
            },
        });
        const handler = lark.adaptDefault(path, dispatcher, { autoChallenge: true });
        server = createServer((request, response) => {
            void handler(request, response);
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                resolve();
            });
        });
    }
    return {
        direction: eventMode === 'off' ? 'outgoing' : 'bidirectional',
        send: sendText,
        setFinalReaction,
        supportsStreamingCards: true,
        supportsCardkit: true,
        onCardAction(handler) {
            cardActionHandlers.add(handler);
            if (cardActionHandlers.size > 100) {
                const oldest = cardActionHandlers.values().next().value;
                cardActionHandlers.delete(oldest);
            }
            return () => cardActionHandlers.delete(handler);
        },
        async createStreamCard(card) {
            const response = await client.cardkit.v1.card.create({
                data: { type: 'card_json', data: JSON.stringify(card) },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu cardkit create error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
            return { cardId: response.data?.card_id };
        },
        async sendStreamCard(message, cardId) {
            const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
            const replyToMessageId = typeof message.metadata?.messageId === 'string'
                ? message.metadata.messageId
                : typeof message.metadata?.replyToMessageId === 'string'
                    ? message.metadata.replyToMessageId
                    : undefined;
            if (replyToMessageId) {
                const response = await client.im.message.reply({
                    path: { message_id: replyToMessageId },
                    data: {
                        msg_type: 'interactive',
                        content,
                        reply_in_thread: cfg.replyInThread ?? Boolean(message.metadata?.threadId),
                    },
                });
                if (response.code !== 0) {
                    throw new Error(`Feishu cardkit reply error: ${response.msg ?? response.code ?? 'unknown'}`);
                }
                return { messageId: response.data?.message_id };
            }
            const { receiveIdType, receiveId } = resolveReceiveId(message, defaultReceiveIdType);
            const response = await client.im.message.create({
                params: { receive_id_type: receiveIdType },
                data: {
                    receive_id: receiveId,
                    msg_type: 'interactive',
                    content,
                },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu cardkit send error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
            return { messageId: response.data?.message_id };
        },
        async updateStreamCardText(cardId, elementId, content, sequence) {
            const response = await client.cardkit.v1.cardElement.content({
                path: { card_id: cardId, element_id: elementId },
                data: { content, sequence, uuid: `c_${cardId}_${sequence}` },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu cardkit text error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
        },
        async updateStreamCardFull(cardId, card, sequence) {
            const response = await client.cardkit.v1.card.update({
                path: { card_id: cardId },
                data: {
                    card: { type: 'card_json', data: JSON.stringify(card) },
                    sequence,
                    uuid: `u_${cardId}_${sequence}`,
                },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu cardkit update error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
        },
        async finishStreamCard(cardId, sequence, summary) {
            const settings = {
                config: { streaming_mode: false },
                ...(summary ? { summary: { content: summary } } : {}),
            };
            const response = await client.cardkit.v1.card.settings({
                path: { card_id: cardId },
                data: {
                    settings: JSON.stringify(settings),
                    sequence,
                    uuid: `s_${cardId}_${sequence}`,
                },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu cardkit finish error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
        },
        async sendCard(message, card) {
            const content = JSON.stringify(card);
            const replyToMessageId = typeof message.metadata?.messageId === 'string'
                ? message.metadata.messageId
                : typeof message.metadata?.replyToMessageId === 'string'
                    ? message.metadata.replyToMessageId
                    : undefined;
            if (replyToMessageId) {
                const response = await client.im.message.reply({
                    path: { message_id: replyToMessageId },
                    data: {
                        msg_type: 'interactive',
                        content,
                        reply_in_thread: cfg.replyInThread ?? Boolean(message.metadata?.threadId),
                    },
                });
                if (response.code !== 0) {
                    throw new Error(`Feishu card reply error: ${response.msg ?? response.code ?? 'unknown'}`);
                }
                return { messageId: response.data?.message_id };
            }
            const { receiveIdType, receiveId } = resolveReceiveId(message, defaultReceiveIdType);
            const response = await client.im.message.create({
                params: { receive_id_type: receiveIdType },
                data: {
                    receive_id: receiveId,
                    msg_type: 'interactive',
                    content,
                },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu card send error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
            return { messageId: response.data?.message_id };
        },
        async updateCard(messageId, card) {
            const response = await client.im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            });
            if (response.code !== 0) {
                throw new Error(`Feishu card update error: ${response.msg ?? response.code ?? 'unknown'}`);
            }
        },
        start,
        async stop() {
            if (channel) {
                await channel.disconnect();
                channel = null;
            }
            if (server) {
                await new Promise((resolve) => server.close(() => resolve()));
                server = null;
            }
        },
    };
}
function resolveEventMode(cfg) {
    if (cfg.eventMode === 'http' || cfg.eventMode === 'websocket' || cfg.eventMode === 'off') {
        return cfg.eventMode;
    }
    if (cfg.incoming?.enabled)
        return 'http';
    return 'websocket';
}
//# sourceMappingURL=feishu.js.map
