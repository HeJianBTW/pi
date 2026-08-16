const DEFAULT_OPEN_API_BASE_URL = 'https://api.dingtalk.com';
const DEFAULT_TOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const DINGTALK_TEXT_MSG_KEY = 'sampleText';
function asConfig(config) {
    return config;
}
function requireString(value, name) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    throw new Error(`DingTalk adapter requires ${name}`);
}
function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function normalizeConfig(config) {
    const cfg = asConfig(config);
    const clientId = requireString(cfg.clientId, 'clientId');
    return {
        ...cfg,
        clientId,
        clientSecret: requireString(cfg.clientSecret, 'clientSecret'),
        robotCode: optionalString(cfg.robotCode) ?? clientId,
        eventMode: cfg.eventMode === 'off' ? 'off' : 'stream',
        openApiBaseUrl: optionalString(cfg.openApiBaseUrl) ?? DEFAULT_OPEN_API_BASE_URL,
        tokenUrl: optionalString(cfg.tokenUrl) ?? DEFAULT_TOKEN_URL,
    };
}
function textFromMessage(message) {
    if (!message.text)
        throw new Error('DingTalk adapter requires text');
    return message.source ? `[${message.source}]\n${message.text}` : message.text;
}
function shouldAcceptMessage(body, cfg) {
    const conversationId = body.conversationId ?? '';
    const allowedConversationIds = cfg.allowedConversationIds;
    if (conversationId &&
        Array.isArray(allowedConversationIds) &&
        allowedConversationIds.length > 0 &&
        !allowedConversationIds.includes(conversationId)) {
        return false;
    }
    const senderId = body.senderId ?? body.senderStaffId ?? '';
    const allowedSenderIds = cfg.allowedSenderIds;
    if (senderId &&
        Array.isArray(allowedSenderIds) &&
        allowedSenderIds.length > 0 &&
        !allowedSenderIds.includes(senderId)) {
        return false;
    }
    if ((cfg.respondToMentionsOnly ?? true) &&
        body.conversationType !== '1' &&
        body.isInAtList === false) {
        return false;
    }
    return true;
}
function senderForMessage(body) {
    return body.conversationId ?? body.senderId ?? body.senderStaffId ?? '';
}
function metadataFromMessage(body) {
    return {
        messageId: body.msgId,
        replyToMessageId: body.msgId,
        conversationId: body.conversationId,
        chatId: body.conversationId,
        groupId: body.conversationId,
        conversationTitle: body.conversationTitle,
        chatName: body.conversationTitle,
        groupName: body.conversationTitle,
        conversationType: body.conversationType,
        senderId: body.senderId,
        senderStaffId: body.senderStaffId,
        senderNick: body.senderNick,
        senderName: body.senderNick,
        sessionWebhook: body.sessionWebhook,
        sessionWebhookExpiredTime: body.sessionWebhookExpiredTime,
        robotCode: body.robotCode,
        chatbotCorpId: body.chatbotCorpId,
        chatbotUserId: body.chatbotUserId,
        createAt: body.createAt,
        rawMsgtype: body.msgtype,
    };
}
function parseRobotMessage(downstream) {
    if (downstream.headers.topic !== '/v1.0/im/bot/messages/get')
        return undefined;
    try {
        const parsed = JSON.parse(downstream.data);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function sessionWebhookFromMetadata(metadata) {
    const value = metadata?.sessionWebhook;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function sessionWebhookIsFresh(metadata) {
    const value = metadata?.sessionWebhookExpiredTime;
    if (typeof value !== 'number' || !Number.isFinite(value))
        return true;
    return value > Date.now();
}
function normalizeApiBaseUrl(value) {
    return value.replace(/\/+$/, '');
}
async function readJsonResponse(response) {
    const text = await response.text();
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function formatDingTalkApiError(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return undefined;
    const record = body;
    const code = record.code ?? record.errcode;
    if (code === undefined || code === 0 || code === '0')
        return undefined;
    const message = record.message ?? record.errmsg;
    return `DingTalk API error ${String(code)}${message ? `: ${String(message)}` : ''}`;
}
export function createDingTalkAdapter(config, context = {}) {
    const cfg = normalizeConfig(config);
    let client = null;
    let streamModulePromise = null;
    let accessToken;
    async function loadStreamModule() {
        streamModulePromise ??= import('dingtalk-stream');
        return streamModulePromise;
    }
    async function getAccessToken() {
        if (accessToken && accessToken.expiresAt > Date.now())
            return accessToken.token;
        const url = new URL(cfg.tokenUrl);
        url.searchParams.set('appkey', cfg.clientId);
        url.searchParams.set('appsecret', cfg.clientSecret);
        const response = await fetch(url);
        const body = (await readJsonResponse(response));
        if (!response.ok) {
            throw new Error(`DingTalk token error ${response.status}: ${JSON.stringify(body)}`);
        }
        if (body?.errcode && body.errcode !== 0) {
            throw new Error(`DingTalk token error ${body.errcode}: ${body.errmsg ?? 'unknown'}`);
        }
        if (!body?.access_token)
            throw new Error('DingTalk token response missing access_token');
        const expiresIn = Number.isFinite(body.expires_in) ? Number(body.expires_in) : 7200;
        accessToken = {
            token: body.access_token,
            expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
        };
        return accessToken.token;
    }
    async function sendViaSessionWebhook(url, text) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
                msgtype: 'text',
                text: { content: text },
            }),
        });
        const body = await readJsonResponse(response);
        if (!response.ok) {
            throw new Error(`DingTalk session webhook error ${response.status}: ${JSON.stringify(body)}`);
        }
        const apiError = formatDingTalkApiError(body);
        if (apiError)
            throw new Error(apiError);
    }
    async function sendViaOpenApi(recipient, text) {
        const conversationId = recipient.trim();
        if (!conversationId)
            throw new Error('DingTalk adapter requires recipient');
        const token = await getAccessToken();
        const response = await fetch(`${normalizeApiBaseUrl(cfg.openApiBaseUrl)}/v1.0/robot/groupMessages/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'x-acs-dingtalk-access-token': token,
            },
            body: JSON.stringify({
                robotCode: cfg.robotCode,
                openConversationId: conversationId,
                msgKey: DINGTALK_TEXT_MSG_KEY,
                msgParam: JSON.stringify({ content: text }),
            }),
        });
        const body = await readJsonResponse(response);
        if (!response.ok) {
            throw new Error(`DingTalk send error ${response.status}: ${JSON.stringify(body)}`);
        }
        const apiError = formatDingTalkApiError(body);
        if (apiError)
            throw new Error(apiError);
    }
    async function sendText(message) {
        const text = textFromMessage(message);
        const sessionWebhook = sessionWebhookFromMetadata(message.metadata);
        if (sessionWebhook && sessionWebhookIsFresh(message.metadata)) {
            await sendViaSessionWebhook(sessionWebhook, text);
            return;
        }
        await sendViaOpenApi(message.recipient, text);
    }
    async function start(onMessage) {
        if (cfg.eventMode === 'off')
            return;
        if (client)
            return;
        const stream = await loadStreamModule();
        client = new stream.DWClient({
            clientId: cfg.clientId,
            clientSecret: cfg.clientSecret,
            ...(cfg.ua ? { ua: cfg.ua } : { ua: 'amaster-pi-channels' }),
            ...(cfg.keepAlive !== undefined ? { keepAlive: cfg.keepAlive } : {}),
            ...(cfg.debug !== undefined ? { debug: cfg.debug } : {}),
        });
        client.registerCallbackListener(stream.TOPIC_ROBOT, (downstream) => {
            try {
                const body = parseRobotMessage(downstream);
                if (!body)
                    return;
                if (!shouldAcceptMessage(body, cfg))
                    return;
                if (body.msgtype !== 'text')
                    return;
                const text = body.text?.content?.trim();
                const sender = senderForMessage(body);
                if (!text || !sender)
                    return;
                void onMessage({
                    adapter: 'dingtalk',
                    sender,
                    text,
                    metadata: metadataFromMessage(body),
                });
            }
            finally {
                try {
                    client?.socketCallBackResponse(downstream.headers.messageId, null);
                }
                catch (error) {
                    context.log?.('dingtalk-stream-ack-failed', { error: error instanceof Error ? error.message : String(error) }, 'WARN');
                }
            }
        });
        await client.connect();
    }
    return {
        direction: cfg.eventMode === 'off' ? 'outgoing' : 'bidirectional',
        send: sendText,
        start,
        async stop() {
            client?.disconnect();
            client = null;
        },
    };
}
//# sourceMappingURL=dingtalk.js.map