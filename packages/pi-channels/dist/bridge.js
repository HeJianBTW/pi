import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_CONTENT_ID, applyCardEvent, buildCard, createCardState, finalizeCardState, mainContentText } from './streaming-card.js';
const DEFAULTS = {
    enabled: false,
    timeoutMs: 300_000,
    maxQueuePerSender: 5,
    maxConcurrent: 2,
    model: null,
    provider: null,
    piBin: '',
    commands: true,
    persistSessions: true,
    apiBase: '',
    env: {},
    streamingCards: false,
    attachMcpAdapter: true,
    vision: {},
};
let idCounter = 0;

export class ImageBatcher {
    pending = new Map();
    constructor({ windowMs, maxImages, onFlush }) {
        this.windowMs = windowMs;
        this.maxImages = maxImages;
        this.onFlush = onFlush;
    }
    add(senderKey, message) {
        let batch = this.pending.get(senderKey);
        if (!batch) {
            batch = { messages: [], timer: setTimeout(() => this.flush(senderKey), this.windowMs) };
            this.pending.set(senderKey, batch);
        }
        batch.messages.push(message);
        if (batch.messages.length >= this.maxImages)
            this.flush(senderKey);
    }
    flush(senderKey) {
        const batch = this.pending.get(senderKey);
        if (!batch)
            return;
        this.pending.delete(senderKey);
        clearTimeout(batch.timer);
        this.onFlush(senderKey, batch.messages);
    }
    clear() {
        for (const batch of this.pending.values())
            clearTimeout(batch.timer);
        this.pending.clear();
    }
}

export async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workers }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    }));
    return results;
}

export function buildImageBatchPrompt(results) {
    return [
        `【用户发来 ${results.length} 张图片，按图片编号理解，勿混淆不同图片的内容】`,
        ...results.map((result, index) => result.ok
            ? `【图片 ${index + 1}】\n${result.text}`
            : `【图片 ${index + 1} 识别失败】\n${result.error}`),
        '请根据以上图片内容回答用户；若某张图片识别失败，请明确说明该图片未能处理，不要猜测其内容。',
    ].join('\n\n');
}

export async function retryCardkitOperation(operation, options = {}) {
    const retries = Math.max(0, Math.min(3, Number.isFinite(options.retries) ? Math.floor(options.retries) : 2));
    const delayMs = Math.max(0, Number.isFinite(options.delayMs) ? Math.floor(options.delayMs) : 300);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt < retries && delayMs > 0)
                await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// Card-state persistence + restart self-healing.
// Streaming cards live only in memory; if the bridge process is restarted
// mid-task the card would stay stuck in 'thinking' forever. We persist a
// lightweight snapshot per active card and, on startup, mark any card that
// was never finished as interrupted.
// ---------------------------------------------------------------------------
const CARD_STATE_FILE = join(process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || '.', '.pi', 'agent'), 'card-state.json');
let cardStates = new Map(); // cardId -> { cardId, state, adapter, sequence, ts }

function loadCardStates() {
    try {
        if (!existsSync(CARD_STATE_FILE))
            return new Map();
        const parsed = JSON.parse(readFileSync(CARD_STATE_FILE, 'utf8'));
        const map = new Map();
        for (const rec of Array.isArray(parsed) ? parsed : []) {
            if (rec?.cardId && rec?.state)
                map.set(rec.cardId, rec);
        }
        return map;
    }
    catch {
        return new Map();
    }
}

function saveCardStates() {
    try {
        mkdirSync(dirname(CARD_STATE_FILE), { recursive: true });
        writeFileSync(CARD_STATE_FILE, JSON.stringify([...cardStates.values()]), 'utf8');
    }
    catch {
        // best effort
    }
}

function persistCardState(cardId, state, adapter, sequence) {
    cardStates.set(cardId, { cardId, state, adapter, sequence: sequence || 0, ts: Date.now() });
    saveCardStates();
}

function dropCardState(cardId) {
    cardStates.delete(cardId);
    saveCardStates();
}

async function healOrphanedCards(registry, orphanIds) {
    // Adopt the on-disk records into the module map (fresh process starts empty),
    // otherwise saveCardStates() below would wipe the file.
    if (cardStates.size === 0)
        cardStates = loadCardStates();
    if (cardStates.size === 0)
        return;
    for (const [cardId, rec] of [...cardStates]) {
        // Never heal cards created AFTER startup: the healer retries span
        // several minutes, and a card that is actively streaming from the
        // current process must not be marked interrupted (its streaming mode
        // would be closed mid-flight). Only the orphan set captured at startup
        // may be touched.
        if (orphanIds && !orphanIds.has(cardId))
            continue;
        const status = rec.state?.status;
        if (status === 'done' || status === 'interrupted') {
            cardStates.delete(cardId);
            continue;
        }
        const adapter = registry.getAdapter(rec.adapter);
        if (!adapter?.updateStreamCardFull || !adapter?.finishStreamCard)
            continue;
        try {
            rec.state.status = 'interrupted';
            rec.state.errorText = '（进程重启，流式任务中断）';
            const card = buildCard(rec.state, true);
            // The persisted sequence is a stale snapshot (saved at most every 2s);
            // the server may already have a higher one, so "snapshot + 1" is
            // rejected with "sequence number compare failed". Jump far ahead
            // (never reused) so the update is always accepted after a restart.
            const seq = Math.floor(Date.now() / 1000) + 1_000_000;
            await retryCardkitOperation(() => adapter.updateStreamCardFull(cardId, card, seq));
            await retryCardkitOperation(() => adapter.finishStreamCard(cardId, seq + 1, '⚠️ 已中断'));
            cardStates.delete(cardId);
            console.warn('[pi-channels] healed interrupted card', { cardId });
        }
        catch (error) {
            console.warn('[pi-channels] heal_failed', { cardId, error: error instanceof Error ? error.message : String(error) });
        }
    }
    saveCardStates();
}
export class ChatBridge {
    config;
    cwd;
    registry;
    running = false;
    activeCount = 0;
    sessions = new Map();
    imageBatcher;
    constructor(config, cwd, registry) {
        this.config = { ...DEFAULTS, ...(config ?? {}) };
        this.cwd = cwd;
        this.registry = registry;
        this.imageBatcher = new ImageBatcher({
            windowMs: visionOption(this.config.vision?.batchWindowMs, 3_000, 250, 10_000),
            maxImages: visionOption(this.config.vision?.maxBatchImages, 9, 1, 9),
            onFlush: (senderKey, messages) => void this.enqueueImageBatch(senderKey, messages),
        });
    }
    start() {
        this.running = true;
        // Capture the orphan set ONCE: only cards that existed at startup may
        // be healed. Retries span ~3.5 minutes; without this, a card created
        // right after startup (actively streaming) would be mistaken for an
        // orphan, marked interrupted, and have its streaming mode closed.
        const orphanIds = new Set([...loadCardStates().values()].map((r) => r.cardId));
        // Heal cards orphaned by a previous crash/restart. Try a few times with
        // backoff in case the adapter (or its REST client) is not ready yet.
        let attempt = 0;
        const tryHeal = () => {
            if (!this.running || attempt >= 6)
                return;
            healOrphanedCards(this.registry, orphanIds).finally(() => {
                attempt++;
                setTimeout(tryHeal, attempt === 1 ? 10_000 : 30_000);
            });
        };
        setTimeout(tryHeal, 3000);
    }
    stop() {
        this.running = false;
        this.imageBatcher.clear();
        for (const session of this.sessions.values())
            session.abortController?.abort();
        this.sessions.clear();
        this.activeCount = 0;
    }
    isActive() {
        return this.running;
    }
    stats() {
        let queued = 0;
        for (const session of this.sessions.values())
            queued += session.queue.length;
        return {
            active: this.running,
            sessions: this.sessions.size,
            activePrompts: this.activeCount,
            queued,
        };
    }
    async handleMessage(message) {
        if (!this.running)
            return;
        const text = message.text.trim();
        if (!text)
            return;
        const senderKey = `${message.adapter}:${message.sender}`;
        const builtInReply = this.handleBuiltInCommand(senderKey, text);
        if (builtInReply !== null) {
            await this.registry.send({
                adapter: message.adapter,
                recipient: message.sender,
                text: builtInReply,
                ...(message.metadata ? { metadata: message.metadata } : {}),
            });
            return;
        }
        if (isBatchableFeishuImage(message)) {
            this.imageBatcher.add(senderKey, message);
            return;
        }
        await this.enqueueMessage(senderKey, message);
    }
    async enqueueImageBatch(senderKey, messages) {
        const last = messages.at(-1);
        if (!last)
            return;
        await this.enqueueMessage(senderKey, {
            ...last,
            text: '[图片]',
            imageBatch: messages.map((message) => ({
                imageDataUrl: message.imageDataUrl,
                imageError: message.imageError,
            })),
        });
    }
    async enqueueMessage(senderKey, message) {
        const session = this.getSession(senderKey);
        if (session.queue.length >= this.config.maxQueuePerSender) {
            await this.registry.send({
                adapter: message.adapter,
                recipient: message.sender,
                text: `Queue full (${this.config.maxQueuePerSender} pending). Wait or send /abort.`,
                ...(message.metadata ? { metadata: message.metadata } : {}),
            });
            return;
        }
        session.queue.push({ id: `msg-${Date.now()}-${++idCounter}`, message });
        void persistChannelTurnStarted({
            apiBase: this.config.apiBase,
            enabled: this.config.persistSessions,
            cwd: this.cwd,
            message,
        });
        await this.sendProcessingAck(message);
        void this.processNext(senderKey);
    }
    async sendProcessingAck(message) {
        if (!shouldSendProcessingAck(message))
            return;
        const metadata = message.adapter === 'wecom'
            ? {
                ...message.metadata,
                wecomReplyFinish: false,
            }
            : message.metadata;
        await this.registry
            .send({
            adapter: message.adapter,
            recipient: message.sender,
            text: '收到，正在处理...',
            ...(metadata ? { metadata } : {}),
        })
            .catch(() => undefined);
    }
    getSession(senderKey) {
        let session = this.sessions.get(senderKey);
        if (!session) {
            session = { queue: [], processing: false, abortController: undefined };
            this.sessions.set(senderKey, session);
        }
        return session;
    }
    handleBuiltInCommand(senderKey, text) {
        if (!this.config.commands || !text.startsWith('/'))
            return null;
        const [command] = text.slice(1).trim().split(/\s+/);
        if (!command)
            return null;
        if (command === 'status') {
            const stats = this.stats();
            return [
                'Channel bridge status',
                `- Active: ${stats.active}`,
                `- Sessions: ${stats.sessions}`,
                `- Active prompts: ${stats.activePrompts}`,
                `- Queued: ${stats.queued}`,
            ].join('\n');
        }
        if (command === 'abort') {
            const session = this.sessions.get(senderKey);
            if (!session?.abortController)
                return 'Nothing is running right now.';
            session.abortController.abort();
            return 'Aborting current prompt...';
        }
        if (command === 'new') {
            const session = this.sessions.get(senderKey);
            session?.abortController?.abort();
            this.sessions.delete(senderKey);
            return 'Session reset.';
        }
        if (command === 'help' || command === 'start') {
            return 'Send a message to talk with pi. Commands: /status, /abort, /new.';
        }
        return null;
    }
    async processNext(senderKey) {
        const session = this.sessions.get(senderKey);
        if (!session || session.processing || session.queue.length === 0)
            return;
        if (this.activeCount >= this.config.maxConcurrent)
            return;
        const queued = session.queue.shift();
        if (!queued)
            return;
        session.processing = true;
        this.activeCount++;
        const ac = new AbortController();
        session.abortController = ac;
        const adapter = this.registry.getAdapter(queued.message.adapter);
        adapter?.sendTyping?.(queued.message.sender).catch(() => undefined);
        const bridgeModel = this.config.model ?? resolveDefaultBridgeModel();
        const bridgeProvider = this.config.provider ?? resolveDefaultBridgeProvider(bridgeModel);
        const sessionId = channelSessionId(queued.message);
        // Vision pipeline: image batches are described independently, with a
        // bounded concurrency, then reassembled in arrival order for Pi.
        let prompt = queued.message.text;
        // Time inject (per-turn, bridge level): pi's before_agent_start extension
        // does not reliably reach channel sessions (compaction / extension load).
        // Injecting here guarantees the model always sees fresh Asia/Shanghai time.
        try {
            const _now = new Date();
            const _cn = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'medium',
            }).format(_now);
            const _iso = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }).format(_now);
            prompt = `[当前时间 Asia/Shanghai] ${_cn}（${_iso}）\n\n${prompt}`;
        } catch { /* 注入失败静默降级 */ }
        if (Array.isArray(queued.message.imageBatch)) {
            const visions = await describeImagesWithVision(queued.message.imageBatch, this.config.vision);
            prompt = buildImageBatchPrompt(visions);
        }
        else if (queued.message.imageDataUrl) {
            const vision = await describeImageWithVision(queued.message.imageDataUrl, this.config.vision);
            prompt = buildImageBatchPrompt([vision]);
        }
        else if (queued.message.imageError) {
            prompt = `【用户发来一张图片，但下载失败（${queued.message.imageError}），请告知用户图片未能处理】`;
        }
        if (queued.message.adapter === 'feishu')
            prompt += FEISHU_FINAL_REACTION_INSTRUCTION;
        const promptOptions = {
            cwd: this.cwd,
            prompt,
            ...(sessionId
                ? { sessionFile: channelPromptSessionFile(this.cwd, queued.message, sessionId) }
                : {}),
            timeoutMs: this.config.timeoutMs,
            model: bridgeModel,
            provider: bridgeProvider,
            piBin: this.config.piBin,
            signal: ac.signal,
            env: this.config.env,
            attachMcpAdapter: this.config.attachMcpAdapter,
        };
        const cardStreaming = this.config.streamingCards && adapterSupportsStreaming(adapter);
        let result;
        let reply;
        let finalReaction;
        let cardDelivered = false;
        if (cardStreaming) {
            const cardState = createCardState({
                model: bridgeModel,
                provider: bridgeProvider,
                contextWindow: resolveContextWindow(bridgeModel),
            });
            const cardController = adapter?.supportsCardkit
                ? createCardkitController(adapter, this.registry, queued.message, cardState, {
                    onReady(cardId, sequence) {
                        persistCardState(cardId, cardState, queued.message.adapter, sequence);
                    },
                    onFinish(cardId) {
                        dropCardState(cardId);
                    },
                })
                : createCardController(this.registry, queued.message, cardState);
            cardController.ensureCreated();
            result = await runPromptJson(promptOptions, (event) => {
                const kind = applyCardEvent(cardState, event);
                if (kind)
                    cardController.scheduleUpdate(kind);
            });
            finalReaction = extractFeishuFinalReaction(cardState.answer || result.response || '');
            if (finalReaction.emojiType) {
                cardState.answer = finalReaction.reply;
                result.response = finalReaction.reply;
            }
            cardDelivered = await cardController.finish(result);
            reply = cardState.answer || result.response || (result.ok ? '(no output)' : formatBridgeErrorReply(result.error));
        }
        else {
            result = await runPrompt(promptOptions);
            reply = result.ok
                ? result.response
                : result.response || formatBridgeErrorReply(result.error);
            finalReaction = extractFeishuFinalReaction(reply);
            if (finalReaction.emojiType)
                reply = finalReaction.reply;
        }
        await persistChannelTurn({
            apiBase: this.config.apiBase,
            enabled: this.config.persistSessions,
            cwd: this.cwd,
            message: queued.message,
            reply,
            model: bridgeModel,
            provider: bridgeProvider,
        });
        if (!cardDelivered) {
            await this.registry.send({
                adapter: queued.message.adapter,
                recipient: queued.message.sender,
                text: reply,
                ...(queued.message.metadata ? { metadata: queued.message.metadata } : {}),
            });
        }
        if (result.ok && finalReaction?.emojiType) {
            const messageIds = queued.message.metadata?.imageBatchMessageIds;
            await adapter?.setFinalReaction?.(Array.isArray(messageIds) ? messageIds : [queued.message.metadata?.messageId], finalReaction.emojiType)
                .catch(() => undefined);
        }
        session.abortController = undefined;
        session.processing = false;
        this.activeCount--;
        if (session.queue.length > 0)
            void this.processNext(senderKey);
        this.drainWaiting();
    }
    drainWaiting() {
        if (this.activeCount >= this.config.maxConcurrent)
            return;
        for (const [senderKey, session] of this.sessions) {
            if (!session.processing && session.queue.length > 0) {
                void this.processNext(senderKey);
                if (this.activeCount >= this.config.maxConcurrent)
                    return;
            }
        }
    }
}
function isBatchableFeishuImage(message) {
    return message.adapter === 'feishu'
        && message.text.trim() === '[图片]'
        && Boolean(message.imageDataUrl || message.imageError);
}
function shouldSendProcessingAck(message) {
    if (message.adapter === 'wecom')
        return Boolean(message.metadata?.wecomReplyFrame);
    if (message.adapter === 'dingtalk')
        return typeof message.metadata?.sessionWebhook === 'string';
    return false;
}
async function persistChannelTurn(input) {
    if (!input.enabled)
        return;
    const apiBase = resolvePiAgentApiBase(input.apiBase);
    if (!apiBase)
        return;
    const sessionId = channelSessionId(input.message);
    if (!sessionId)
        return;
    const title = channelSessionTitle(input.message, sessionId);
    const body = {
        phase: 'completed',
        sessionId,
        conversationId: sessionId,
        title,
        adapter: input.message.adapter,
        recipient: sessionId,
        userMessage: input.message.text,
        assistantMessage: input.reply,
        createdAt: channelMessageCreatedAt(input.message),
        workspaceDir: process.env.PI_AGENT_WORKSPACE || input.cwd,
        model: modelPayload(input.provider, input.model),
    };
    try {
        const response = await fetch(`${apiBase}/internal/channel-sessions/turn`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-pi-agent-internal': 'channel-bridge',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            console.warn('[pi-channels] channel_session_persist_failed', {
                status: response.status,
                sessionId,
            });
        }
    }
    catch (error) {
        console.warn('[pi-channels] channel_session_persist_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
async function persistChannelTurnStarted(input) {
    if (!input.enabled)
        return;
    const apiBase = resolvePiAgentApiBase(input.apiBase);
    if (!apiBase)
        return;
    const sessionId = channelSessionId(input.message);
    if (!sessionId)
        return;
    const title = channelSessionTitle(input.message, sessionId);
    const body = {
        phase: 'started',
        sessionId,
        conversationId: sessionId,
        title,
        adapter: input.message.adapter,
        recipient: sessionId,
        userMessage: input.message.text,
        createdAt: channelMessageCreatedAt(input.message),
        workspaceDir: process.env.PI_AGENT_WORKSPACE || input.cwd,
    };
    try {
        const response = await fetch(`${apiBase}/internal/channel-sessions/turn`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-pi-agent-internal': 'channel-bridge',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            console.warn('[pi-channels] channel_session_start_failed', {
                status: response.status,
                sessionId,
            });
        }
    }
    catch (error) {
        console.warn('[pi-channels] channel_session_start_failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
function channelSessionId(message) {
    const metadata = message.metadata ?? {};
    if (message.adapter === 'feishu') {
        return (trimToNull(typeof metadata.chatId === 'string' ? metadata.chatId : undefined) ??
            trimToNull(message.sender.split(':')[0]) ??
            undefined);
    }
    return trimToNull(message.sender.split(':')[0]) ?? undefined;
}
function channelSessionTitle(message, sessionId) {
    const metadata = message.metadata ?? {};
    const name = trimToNull(typeof metadata.chatName === 'string'
        ? metadata.chatName
        : typeof metadata.groupName === 'string'
            ? metadata.groupName
            : undefined) ?? sessionId;
    return `${adapterDisplayName(message.adapter)} / ${name}`;
}
function channelMessageCreatedAt(message) {
    const createTime = message.metadata?.createTime;
    if (typeof createTime === 'number' && Number.isFinite(createTime)) {
        return new Date(createTime > 10_000_000_000 ? createTime : createTime * 1000).toISOString();
    }
    if (typeof createTime === 'string' && createTime.trim()) {
        const numeric = Number(createTime);
        if (Number.isFinite(numeric)) {
            return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
        }
        if (!Number.isNaN(Date.parse(createTime))) {
            return new Date(createTime).toISOString();
        }
    }
    return new Date().toISOString();
}
function adapterDisplayName(adapter) {
    if (adapter === 'feishu')
        return '飞书';
    if (adapter === 'wecom')
        return '企微';
    return adapter;
}
function modelPayload(provider, model) {
    const cleanProvider = trimToNull(provider ?? undefined);
    const cleanModel = trimToNull(model ?? undefined);
    if (!cleanProvider && !cleanModel)
        return undefined;
    return {
        ...(cleanProvider ? { provider: cleanProvider } : {}),
        ...(cleanModel ? { model: cleanModel } : {}),
    };
}
function resolvePiAgentApiBase(configured) {
    const explicit = trimToNull(configured) ??
        trimToNull(process.env.PI_AGENT_API_BASE) ??
        trimToNull(process.env.DESKTOP_API_BASE);
    if (explicit)
        return explicit.replace(/\/+$/, '');
    const port = trimToNull(process.env.DESKTOP_PORT) ?? trimToNull(process.env.PORT);
    return port ? `http://127.0.0.1:${port}` : undefined;
}
function runPrompt(options) {
    return new Promise((resolve) => {
        const args = ['-p', '--offline', '--no-extensions'];
        if (options.sessionFile) {
            args.push('--session', options.sessionFile);
        }
        else {
            args.push('--no-session');
        }
        const model = options.model ?? resolveDefaultBridgeModel();
        const provider = options.provider ?? resolveDefaultBridgeProvider(model);
        if (shouldAttachBridgeProvider(provider)) {
            args.push('-e', resolveBridgeProviderExtensionPath());
        }
        if (options.attachMcpAdapter !== false)
            attachMcpAdapterArgs(args);
        if (provider)
            args.push('--provider', provider);
        if (model)
            args.push('--model', model);
        args.push(formatBridgePrompt(options.prompt));
        const command = resolvePiCommand(options.cwd, options.piBin);
        if (process.env.DEBUG?.includes('pi-channels')) {
            console.error('[pi-channels] bridge_run_prompt', {
                cwd: options.cwd,
                command,
                provider,
                model,
                sessionFile: options.sessionFile,
                hasAnthropicBaseUrl: Boolean(process.env.ANTHROPIC_BASE_URL),
                hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
                providerExtension: shouldAttachBridgeProvider(provider)
                    ? resolveBridgeProviderExtensionPath()
                    : undefined,
            });
        }
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, ...(options.env ?? {}) },
                timeout: options.timeoutMs,
            });
        }
        catch (error) {
            resolve({
                ok: false,
                response: '',
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        const abort = () => child.kill('SIGTERM');
        options.signal?.addEventListener('abort', abort, { once: true });
        child.on('close', (code) => {
            options.signal?.removeEventListener('abort', abort);
            const response = stdout.trim();
            if (options.signal?.aborted) {
                resolve({ ok: false, response: response || '(aborted)', error: 'Aborted' });
            }
            else if (code === 0) {
                resolve({ ok: true, response: response || '(no output)' });
            }
            else {
                resolve({ ok: false, response, error: stderr.trim() || `Exit code ${code ?? 1}` });
            }
        });
        child.on('error', (error) => {
            options.signal?.removeEventListener('abort', abort);
            resolve({ ok: false, response: '', error: error.message });
        });
    });
}
function runPromptJson(options, onEvent) {
    return new Promise((resolve) => {
        const args = ['--mode', 'json', '--offline', '--no-extensions'];
        if (options.sessionFile) {
            args.push('--session', options.sessionFile);
        }
        else {
            args.push('--no-session');
        }
        const model = options.model ?? resolveDefaultBridgeModel();
        const provider = options.provider ?? resolveDefaultBridgeProvider(model);
        if (shouldAttachBridgeProvider(provider)) {
            args.push('-e', resolveBridgeProviderExtensionPath());
        }
        if (options.attachMcpAdapter !== false)
            attachMcpAdapterArgs(args);
        if (provider)
            args.push('--provider', provider);
        if (model)
            args.push('--model', model);
        args.push(formatBridgePrompt(options.prompt));
        const command = resolvePiCommand(options.cwd, options.piBin);
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, ...(options.env ?? {}) },
                timeout: options.timeoutMs,
            });
        }
        catch (error) {
            resolve({
                ok: false,
                response: '',
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        let stdout = '';
        let stderr = '';
        let buffer = '';
        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            buffer += text;
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line)
                    continue;
                try {
                    onEvent(JSON.parse(line));
                }
                catch {
                    // skip non-JSON lines
                }
            }
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        const abort = () => child.kill('SIGTERM');
        options.signal?.addEventListener('abort', abort, { once: true });
        child.on('close', (code) => {
            options.signal?.removeEventListener('abort', abort);
            if (options.signal?.aborted) {
                resolve({ ok: false, response: '', error: 'Aborted' });
            }
            else if (code === 0) {
                resolve({ ok: true, response: '', error: '' });
            }
            else {
                resolve({ ok: false, response: '', error: stderr.trim() || `Exit code ${code ?? 1}` });
            }
        });
        child.on('error', (error) => {
            options.signal?.removeEventListener('abort', abort);
            resolve({ ok: false, response: '', error: error.message });
        });
    });
}
function adapterSupportsStreaming(adapter) {
    return Boolean(adapter?.supportsStreamingCards && adapter?.sendCard && adapter?.updateCard);
}
function createCardController(registry, message, cardState) {
    const MAX_PATCHES = 80;
    const DEBUG_LOG = '/tmp/pi-card-debug.log';
    let cardMessageId = null;
    let created = false;
    let patchCount = 0;
    let lastPatchAt = 0;
    let timer = null;
    let queue = Promise.resolve();
    let finalized = false;
    const debug = (...parts) => {
        try {
            appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
        }
        catch {
            // ignore
        }
    };
    const base = {
        adapter: message.adapter,
        recipient: message.sender,
        metadata: message.metadata,
    };
    async function performUpdate(force = false) {
        try {
            const card = buildCard(cardState, finalized);
            if (!created) {
                const sendResult = await registry.sendCard({ ...base, card });
                if (sendResult.ok && sendResult.messageId) {
                    created = true;
                    cardMessageId = sendResult.messageId;
                    lastPatchAt = Date.now();
                    debug('card_created', cardMessageId, 'model=', cardState.model);
                }
                else {
                    debug('card_create_FAILED', sendResult.error || 'unknown');
                }
                return;
            }
            if (!force && Date.now() - lastPatchAt < 300)
                return;
            if (!force && patchCount >= MAX_PATCHES)
                return;
            const updateResult = await registry.updateCard({ ...base, messageId: cardMessageId, card });
            if (updateResult.ok) {
                patchCount++;
                lastPatchAt = Date.now();
                if (force)
                    debug('card_final_updated', 'patchCount=', patchCount);
            }
            else {
                debug('card_update_FAILED', updateResult.error || 'unknown', 'force=', force, 'patchCount=', patchCount);
            }
        }
        catch (error) {
            debug('performUpdate_EXCEPTION', error instanceof Error ? error.stack || error.message : String(error));
        }
    }
    function enqueueUpdate() {
        queue = queue
            .then(() => performUpdate())
            .catch(() => undefined);
    }
    return {
        get messageId() {
            return cardMessageId;
        },
        ensureCreated() {
            // create the card immediately so it pops up without delay
            enqueueUpdate();
        },
        scheduleUpdate() {
            // Throttle, not debounce: while deltas stream in fast, still push
            // an update at least every 200ms (matches hermes UPDATE_MIN_INTERVAL_SECONDS)
            // so the card visibly grows instead of jumping straight to the final state.
            if (timer)
                return;
            const delay = Math.max(0, 200 - (Date.now() - lastPatchAt));
            timer = setTimeout(() => {
                timer = null;
                enqueueUpdate();
            }, delay);
        },
        async forceUpdate() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            enqueueUpdate();
            await queue;
            await performUpdate(true);
        },
        async finish(result) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            finalizeCardState(cardState, result);
            finalized = true;
            await queue;
            await performUpdate(true);
            debug('finish_done', 'created=', created, 'status=', cardState.status);
            return created;
        },
    };
}

// CardKit streaming controller: creates a card entity and sends it by
// reference, then streams text via cardkit element content (native
// typewriter animation) and does full card updates for structural changes.
// Falls back to im.message.create/patch full-card updates if cardkit fails.
function createCardkitController(adapter, registry, message, cardState, hooks = {}) {
    const MAX_PATCHES = 200;
    const DEBUG_LOG = '/tmp/pi-card-debug.log';
    let cardId = null;
    let messageId = null;
    let created = false;
    let sequence = 0;
    let lastPatchAt = 0;
    let lastSavedAt = 0;
    let timer = null;
    let queue = Promise.resolve();
    let pendingText = false;
    let pendingFull = false;
    let finalized = false;
    let failedCardkit = false;
    let patchCount = 0;
    let inflight = false;
    // True once ANY card update (cardkit or im fallback) has succeeded. If the
    // card dies mid-turn (e.g. streaming closed externally), the answer must
    // still reach the user via the plain-text fallback.
    let anyUpdateSucceeded = false;
    // Replying to an image message makes Feishu embed a quote thumbnail into
    // the reply card. CardKit then rejects every update with "card contains
    // invalid image keys" and the card freezes. For image messages, send the
    // card as a new message instead of a reply (no quote -> no broken card).
    const replyHazard = message.metadata?.rawContentType === 'image';
    const base = {
        adapter: message.adapter,
        recipient: message.sender,
        metadata: replyHazard
            ? { ...message.metadata, messageId: undefined, messageIdForReply: undefined, replyToMessageId: undefined }
            : message.metadata,
    };
    const debug = (...parts) => {
        try {
            appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
        }
        catch {
            // ignore
        }
    };
    async function createCard() {
        if (!failedCardkit) {
            try {
                const card = buildCard(cardState, false);
                const cr = await retryCardkitOperation(() => adapter.createStreamCard(card));
                if (cr.cardId) {
                    cardId = cr.cardId;
                    const sr = await adapter.sendStreamCard({ ...base }, cardId);
                    messageId = sr.messageId || null;
                    created = true;
                    lastPatchAt = Date.now();
                    debug('cardkit_created', cardId, 'msg=', messageId, 'model=', cardState.model);
                    hooks.onReady?.(cardId, sequence);
                    return;
                }
                failedCardkit = true;
                debug('cardkit_create_empty', 'fallback');
            }
            catch (error) {
                failedCardkit = true;
                debug('cardkit_create_FAILED', error instanceof Error ? error.message : String(error), 'fallback');
            }
        }
        // fallback: full card via im.message
        const card = buildCard(cardState, finalized);
        const sendResult = await registry.sendCard({ ...base, card });
        if (sendResult.ok && sendResult.messageId) {
            created = true;
            messageId = sendResult.messageId;
            lastPatchAt = Date.now();
            debug('card_created_im_fallback', messageId);
        }
        else {
            debug('card_create_FAILED', sendResult.error || 'unknown');
        }
    }
    async function doTextUpdate() {
        if (failedCardkit || !cardId)
            return;
        sequence++;
        try {
            await retryCardkitOperation(() => adapter.updateStreamCardText(cardId, MAIN_CONTENT_ID, mainContentText(cardState), sequence));
            anyUpdateSucceeded = true;
        }
        catch (error) {
            failedCardkit = true;
            debug('cardkit_text_FAILED', error instanceof Error ? error.message : String(error), 'fallback');
        }
    }
    async function doFullUpdate() {
        const card = buildCard(cardState, finalized);
        if (!failedCardkit && cardId) {
            sequence++;
            try {
                await retryCardkitOperation(() => adapter.updateStreamCardFull(cardId, card, sequence));
                anyUpdateSucceeded = true;
                return;
            }
            catch (error) {
                failedCardkit = true;
                debug('cardkit_full_FAILED', error instanceof Error ? error.message : String(error), 'fallback');
            }
        }
        if (!created)
            return;
        if (patchCount >= MAX_PATCHES)
            return;
        const updateResult = await registry.updateCard({ ...base, messageId, card });
        if (updateResult.ok) {
            patchCount++;
            anyUpdateSucceeded = true;
        }
        else {
            debug('im_update_FAILED', updateResult.error || 'unknown');
        }
    }
    async function performUpdate() {
        if (inflight)
            return;
        inflight = true;
        try {
            // drain all pending work; each update reads the latest state, so
            // coalescing is safe (no stale intermediate updates pile up)
            do {
                if (!created) {
                    await createCard();
                }
                else if (pendingFull) {
                    pendingFull = false;
                    pendingText = false;
                    await doFullUpdate();
                }
                else if (pendingText) {
                    pendingText = false;
                    await doTextUpdate();
                }
                lastPatchAt = Date.now();
                if (cardId && Date.now() - lastSavedAt > 2000) {
                    lastSavedAt = Date.now();
                    persistCardState(cardId, cardState, message.adapter, sequence);
                }
            } while (pendingFull || pendingText);
        }
        catch (error) {
            debug('performUpdate_EXCEPTION', error instanceof Error ? error.stack || error.message : String(error));
        }
        finally {
            inflight = false;
        }
    }
    function enqueueUpdate() {
        queue = queue
            .then(() => performUpdate())
            .catch(() => undefined);
    }
    return {
        get messageId() {
            return messageId;
        },
        ensureCreated() {
            enqueueUpdate();
        },
        scheduleUpdate(kind) {
            if (kind === 'full') {
                pendingFull = true;
            }
            else if (kind === 'text') {
                pendingText = true;
            }
            if (timer || inflight)
                return;
            const delay = Math.max(0, 200 - (Date.now() - lastPatchAt));
            timer = setTimeout(() => {
                timer = null;
                enqueueUpdate();
            }, delay);
        },
        async finish(result) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            finalizeCardState(cardState, result);
            finalized = true;
            await queue;
            // 1) animate any remaining text via the typewriter first,
            //    so the tail does not jump in from the full update
            pendingText = true;
            pendingFull = false;
            await performUpdate();
            // 2) final full update: header/footer/status
            pendingText = false;
            pendingFull = true;
            await performUpdate();
            // 3) close streaming mode (removes typing cursor)
            if (!failedCardkit && created && cardId) {
                sequence++;
                try {
                    await retryCardkitOperation(() => adapter.finishStreamCard(cardId, sequence, '已完成'));
                    debug('cardkit_finished');
                    hooks.onFinish?.(cardId);
                }
                catch (error) {
                    debug('cardkit_finish_FAILED', error instanceof Error ? error.message : String(error));
                    // Keep the persisted state for the restart healer and make
                    // one delayed retry while this process is still alive.
                    setTimeout(() => {
                        sequence++;
                        retryCardkitOperation(() => adapter.finishStreamCard(cardId, sequence, '已完成'))
                            .then(() => {
                            debug('cardkit_finished_delayed');
                            hooks.onFinish?.(cardId);
                        })
                            .catch((retryError) => debug('cardkit_finish_retry_FAILED', retryError instanceof Error ? retryError.message : String(retryError)));
                    }, 2_000);
                }
            }
            debug('finish_done', 'created=', created, 'status=', cardState.status, 'cardkit=', !failedCardkit);
            if (cardId && (failedCardkit || !created))
                hooks.onFinish?.(cardId);
            // Only claim delivery if the card actually carried content at some
            // point. A created-but-never-updatable card (streaming closed by
            // the healer or externally) must fall back to plain text so the
            // answer is never lost.
            return created && anyUpdateSucceeded;
        },
    };
}
export function resolveVisionConfig(visionConfig, models) {
    const providers = models?.providers ?? {};
    const configuredProvider = String(visionConfig?.provider ?? '').trim();
    const configuredModel = String(visionConfig?.model ?? '').trim();
    let providerName = configuredProvider;
    let provider = configuredProvider ? providers[configuredProvider] : undefined;
    if (!provider) {
        const discovered = Object.entries(providers).find(([, value]) =>
            (value?.models ?? []).some((model) => /vl|vision|image/i.test(String(model?.id ?? ''))),
        );
        if (!discovered)
            return null;
        [providerName, provider] = discovered;
    }
    const model = configuredModel || provider?.models?.find((entry) => /vl|vision|image/i.test(String(entry?.id ?? '')))?.id;
    const baseUrl = String(provider?.baseUrl ?? '').replace(/\/$/u, '');
    const apiKey = String(provider?.apiKey ?? '');
    if (!providerName || !model || !baseUrl || !apiKey)
        return null;
    return { provider: providerName, model: String(model), baseUrl, apiKey };
}

function visionOption(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
}

function isRetryableVisionStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

function visionError(code) {
    return { ok: false, error: code };
}

async function describeImagesWithVision(images, visionConfig = {}) {
    const concurrency = visionOption(visionConfig?.concurrency, 3, 1, 3);
    return mapWithConcurrency(images, concurrency, (image) => image.imageDataUrl
        ? describeImageWithVision(image.imageDataUrl, visionConfig)
        : visionError(image.imageError || 'vision_image_invalid'));
}

async function describeImageWithVision(imageDataUrl, visionConfig = {}) {
    // Asks the vision provider (qwen-vl) to describe the image, working purely
    // in memory (the data URL is the only copy; nothing is written to disk).
    // Returns the description text or null on failure.
    try {
        const configDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || '.', '.pi', 'agent');
        const modelsPath = join(configDir, 'models.json');
        if (!existsSync(modelsPath) || !imageDataUrl)
            return visionError('vision_configuration_missing');
        const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
        const resolved = resolveVisionConfig(visionConfig, models);
        if (!resolved)
            return visionError('vision_configuration_invalid');
        const imgB64 = String(imageDataUrl).split(',')[1] ?? '';
        const mime = String(imageDataUrl).match(/^data:([^;]+)/)?.[1] ?? 'image/png';
        if (!imgB64)
            return visionError('vision_image_invalid');
        const maxImageBytes = visionOption(visionConfig?.maxImageBytes, 4 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024);
        if (Buffer.byteLength(imgB64, 'base64') > maxImageBytes)
            return visionError('vision_image_too_large');
        const timeoutMs = visionOption(visionConfig?.timeoutMs, 60_000, 5_000, 120_000);
        const retries = visionOption(visionConfig?.retries, 2, 0, 3);
        const maxTokens = visionOption(visionConfig?.maxTokens, 220, 80, 500);
        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        Authorization: `Bearer ${resolved.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: resolved.model,
                        messages: [{ role: 'user', content: [
                            { type: 'text', text: '请详细描述这张图片的内容：主要物体、人物、文字、颜色、场景等。如果是截图请完整保留关键文字。用中文回答，100-200字。' },
                            { type: 'image_url', image_url: { url: `data:${mime};base64,${imgB64}` } },
                        ] }],
                        max_tokens: maxTokens,
                    }),
                });
                if (!response.ok) {
                    if (attempt < retries && isRetryableVisionStatus(response.status)) {
                        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                        continue;
                    }
                    return visionError(`vision_http_${response.status}`);
                }
                const payload = await response.json();
                const text = payload?.choices?.[0]?.message?.content;
                return typeof text === 'string' && text.trim()
                    ? { ok: true, text: text.trim() }
                    : visionError('vision_response_invalid');
            }
            catch (error) {
                const code = error?.name === 'AbortError' ? 'vision_timeout' : 'vision_network_error';
                if (attempt < retries) {
                    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                    continue;
                }
                return visionError(code);
            }
            finally {
                clearTimeout(timer);
            }
        }
        return visionError('vision_network_error');
    }
    catch {
        return visionError('vision_configuration_invalid');
    }
}

function resolveContextWindow(model) {
    if (!model)
        return 0;
    try {
        const configDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || '.', '.pi', 'agent');
        const storePath = join(configDir, 'models-store.json');
        if (!existsSync(storePath))
            return 0;
        const store = JSON.parse(readFileSync(storePath, 'utf8'));
        for (const provider of Object.values(store)) {
            for (const entry of provider?.models || []) {
                if (entry?.id === model && entry?.contextWindow) {
                    return entry.contextWindow;
                }
            }
        }
    }
    catch {
        // non-fatal
    }
    return 0;
}
function channelPromptSessionFile(cwd, message, sessionId) {
    const sessionDir = join(cwd, '.pi', 'channel-sessions');
    if (existsSync(cwd))
        mkdirSync(sessionDir, { recursive: true });
    const fingerprint = createHash('sha256')
        .update(`${message.adapter}:${sessionId}`)
        .digest('hex')
        .slice(0, 24);
    return join(sessionDir, `${message.adapter}-${fingerprint}.jsonl`);
}
function formatBridgeErrorReply(error) {
    const message = error?.trim();
    if (!message)
        return 'Error: unknown';
    if (/\b401\b/.test(message) ||
        /invalid x-api-key/i.test(message) ||
        /authentication_error/i.test(message)) {
        return '模型服务认证失败，请检查 API Key 后点击“更新配置”或重启服务。';
    }
    return `Error: ${message}`;
}
export const LIVE_STATE_POLICY = `【实时事实规则】用户询问当前配置、模型、服务状态、版本、端口、余额、库存、价格、时间、是否已完成等会变化的事实时，必须先用适当工具读取当前真实来源后再回答。聊天记录、旧回复和你的记忆都不是实时证据；不能读取时，明确说明“无法实时确认”，不得猜测或沿用旧信息。`;
export const WHOOP_FAST_PATH_POLICY = `【WHOOP 快速查询规则】用户询问 WHOOP 健康数据时，必须直接调用 WHOOP MCP 的对应工具；询问“今天/当前状态”优先一次调用已注册的直接工具 whoop_get_today。不要先读取 token、探测配置、手写 Python 轮询脚本或重复重试。单次查询失败时，尽快说明失败原因，不要为了等待结果长时间阻塞。`;
const FEISHU_FINAL_REACTIONS = new Set(['OK', 'THUMBSUP', 'THANKS', 'MUSCLE', 'FINGERHEART', 'APPLAUSE', 'FISTBUMP', 'JIAYI', 'DONE', 'SMILE', 'BLUSH', 'LAUGH', 'LOVE', 'WINK', 'PROUD']);
const FEISHU_FINAL_REACTION_INSTRUCTION = `\n\n【飞书最终表情】回答完成后，根据回答的情绪，从 OK、THUMBSUP、THANKS、MUSCLE、FINGERHEART、APPLAUSE、FISTBUMP、JIAYI、DONE、SMILE、BLUSH、LAUGH、LOVE、WINK、PROUD 中选一个，并仅在回答最后另起一行输出 <!--feishu-reaction:表情类型-->。此标记不会展示给用户；不要解释选择。`;
export function extractFeishuFinalReaction(reply) {
    const match = /\s*<!--feishu-reaction:([A-Z]+)-->\s*$/u.exec(reply);
    if (!match || !FEISHU_FINAL_REACTIONS.has(match[1]))
        return { reply, emojiType: undefined };
    return { reply: reply.slice(0, match.index).trimEnd(), emojiType: match[1] };
}
export function formatBridgePrompt(prompt) {
    return `${LIVE_STATE_POLICY}\n${WHOOP_FAST_PATH_POLICY}\n\n来自即时通讯的用户消息：\n${prompt}`;
}
function resolveDefaultBridgeModel() {
    return trimToNull(process.env.ANTHROPIC_MODEL) ?? trimToNull(process.env.MODEL) ?? null;
}
function resolveDefaultBridgeProvider(model) {
    if (!model || model.includes('/'))
        return null;
    if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY) {
        return 'anthropic-compatible';
    }
    return null;
}
function shouldAttachBridgeProvider(provider) {
    return provider === 'anthropic-compatible';
}
function resolveBridgeProviderExtensionPath() {
    return join(dirname(fileURLToPath(import.meta.url)), 'bridge-provider.js');
}
function resolveMcpAdapterExtensionPath() {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || '.', '.pi', 'agent');
    const candidate = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter', 'index.ts');
    return existsSync(candidate) ? candidate : null;
}
function attachMcpAdapterArgs(args) {
    const mcpAdapter = resolveMcpAdapterExtensionPath();
    if (mcpAdapter)
        args.push('-e', mcpAdapter);
}
function resolvePiCommand(cwd, configured) {
    const explicit = trimToNull(configured) ?? trimToNull(process.env.PI_CHANNELS_PI_BIN);
    if (explicit)
        return explicit;
    for (const candidate of discoverPiBins(cwd)) {
        if (existsSync(candidate))
            return candidate;
    }
    return 'pi';
}
function discoverPiBins(cwd) {
    const bins = [];
    let current = resolve(cwd);
    while (true) {
        bins.push(join(current, 'node_modules', '.bin', piBinName()));
        bins.push(join(current, '.pi', 'npm', 'node_modules', '.bin', piBinName()));
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return bins;
}
function piBinName() {
    return process.platform === 'win32' ? 'pi.cmd' : 'pi';
}
function trimToNull(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
//# sourceMappingURL=bridge.js.map
