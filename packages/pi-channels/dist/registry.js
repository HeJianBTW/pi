import { createDingTalkAdapter } from './adapters/dingtalk.js';
import { createFeishuAdapter } from './adapters/feishu.js';
import { createWebhookAdapter } from './adapters/webhook.js';
import { createWeComAdapter } from './adapters/wecom.js';
const adapterFactories = {
    dingtalk: createDingTalkAdapter,
    feishu: createFeishuAdapter,
    webhook: createWebhookAdapter,
    wecom: createWeComAdapter,
};
export class ChannelRegistry {
    adapters = new Map();
    adapterFingerprints = new Map();
    routes = new Map();
    errors = [];
    onIncoming = () => undefined;
    log;
    setLogger(log) {
        this.log = log;
    }
    setOnIncoming(onIncoming) {
        this.onIncoming = onIncoming;
    }
    async loadConfig(config, cwd) {
        await this.stopAll();
        this.adapters.clear();
        this.adapterFingerprints.clear();
        this.routes.clear();
        this.errors = [];
        this.loadRoutes(config);
        for (const [name, adapterConfig] of Object.entries(config.adapters ?? {})) {
            await this.loadAdapter(name, adapterConfig, cwd);
        }
    }
    loadRoutes(config) {
        this.routes.clear();
        for (const [alias, target] of Object.entries(config.routes ?? {})) {
            this.routes.set(alias, target);
        }
    }
    async loadAdapter(name, config, cwd) {
        const fingerprint = JSON.stringify(config);
        if (this.adapters.has(name) && this.adapterFingerprints.get(name) === fingerprint)
            return;
        this.errors = this.errors.filter((error) => error.adapter !== name);
        const factory = adapterFactories[config.type];
        if (!factory) {
            this.errors.push({ adapter: name, error: `Unknown adapter type: ${config.type}` });
            return;
        }
        const previous = this.adapters.get(name);
        await previous?.stop?.();
        this.adapters.delete(name);
        this.adapterFingerprints.delete(name);
        try {
            const context = this.log
                ? {
                    cwd,
                    log: (event, data, level) => this.log?.(event, { adapter: name, ...(data ?? {}) }, level),
                }
                : { cwd };
            const adapter = await factory(config, context);
            this.adapters.set(name, adapter);
            this.adapterFingerprints.set(name, fingerprint);
        }
        catch (error) {
            this.errors.push({ adapter: name, error: errorMessage(error) });
        }
    }
    async ensureAdapter(name, config, cwd) {
        const adapterConfig = config.adapters?.[name];
        if (!adapterConfig) {
            this.errors = this.errors.filter((error) => error.adapter !== name);
            this.errors.push({ adapter: name, error: `No adapter config "${name}"` });
            return;
        }
        await this.loadAdapter(name, adapterConfig, cwd);
    }
    async startListening(adapterName) {
        for (const [name, adapter] of this.adapters) {
            if (adapterName && name !== adapterName)
                continue;
            if (!adapter.start || adapter.direction === 'outgoing')
                continue;
            try {
                await adapter.start((message) => {
                    const withAdapter = { ...message, adapter: name };
                    try {
                        const maybePromise = this.onIncoming(withAdapter);
                        if (maybePromise instanceof Promise) {
                            maybePromise.catch((error) => {
                                this.errors.push({
                                    adapter: name,
                                    error: `Incoming handler failed: ${errorMessage(error)}`,
                                });
                            });
                        }
                    }
                    catch (error) {
                        this.errors.push({
                            adapter: name,
                            error: `Incoming handler failed: ${errorMessage(error)}`,
                        });
                    }
                });
            }
            catch (error) {
                this.errors.push({ adapter: name, error: `Failed to start: ${errorMessage(error)}` });
            }
        }
    }
    async stopAll() {
        for (const adapter of this.adapters.values()) {
            await adapter.stop?.();
        }
        this.adapters.clear();
        this.adapterFingerprints.clear();
    }
    register(name, adapter) {
        this.adapters.set(name, adapter);
        if (adapter.start && adapter.direction !== 'outgoing') {
            adapter
                .start((message) => this.onIncoming({ ...message, adapter: name }))
                .catch((error) => {
                this.errors.push({ adapter: name, error: `Failed to start: ${errorMessage(error)}` });
            });
        }
    }
    unregister(name) {
        const adapter = this.adapters.get(name);
        adapter?.stop?.();
        return this.adapters.delete(name);
    }
    async send(message) {
        const resolved = this.resolve(message.adapter, message.recipient);
        const adapter = this.adapters.get(resolved.adapter);
        if (!adapter) {
            const error = `No adapter "${resolved.adapter}"`;
            this.log?.('message_send_failed', { adapter: resolved.adapter, recipient: resolved.recipient, error }, 'ERROR');
            return { ok: false, error };
        }
        if (adapter.direction === 'incoming') {
            const error = `Adapter "${resolved.adapter}" is incoming-only`;
            this.log?.('message_send_failed', { adapter: resolved.adapter, recipient: resolved.recipient, error }, 'ERROR');
            return { ok: false, error };
        }
        if (!adapter.send) {
            const error = `Adapter "${resolved.adapter}" cannot send`;
            this.log?.('message_send_failed', { adapter: resolved.adapter, recipient: resolved.recipient, error }, 'ERROR');
            return { ok: false, error };
        }
        try {
            this.log?.('message_send_start', {
                adapter: resolved.adapter,
                recipient: resolved.recipient,
                source: message.source,
                text: message.text,
            });
            await adapter.send({ ...message, adapter: resolved.adapter, recipient: resolved.recipient });
            this.log?.('message_send_ok', {
                adapter: resolved.adapter,
                recipient: resolved.recipient,
                source: message.source,
                text: message.text,
            });
            return { ok: true };
        }
        catch (error) {
            const messageError = errorMessage(error);
            this.log?.('message_send_failed', {
                adapter: resolved.adapter,
                recipient: resolved.recipient,
                source: message.source,
                text: message.text,
                error: messageError,
            }, 'ERROR');
            return { ok: false, error: messageError };
        }
    }
    getAdapter(name) {
        return this.adapters.get(name);
    }
    async sendCard(message) {
        const resolved = this.resolve(message.adapter, message.recipient);
        const adapter = this.adapters.get(resolved.adapter);
        if (!adapter?.sendCard) {
            const error = `Adapter "${resolved.adapter}" does not support cards`;
            this.log?.('card_send_failed', { adapter: resolved.adapter, error }, 'ERROR');
            return { ok: false, error };
        }
        try {
            const result = await adapter.sendCard({
                ...message,
                adapter: resolved.adapter,
                recipient: resolved.recipient,
            }, message.card);
            this.log?.('card_send_ok', { adapter: resolved.adapter, recipient: resolved.recipient });
            return { ok: true, messageId: result?.messageId };
        }
        catch (error) {
            const cardError = errorMessage(error);
            this.log?.('card_send_failed', {
                adapter: resolved.adapter,
                recipient: resolved.recipient,
                error: cardError,
            }, 'ERROR');
            return { ok: false, error: cardError };
        }
    }
    async updateCard(message) {
        const resolved = this.resolve(message.adapter, message.recipient);
        const adapter = this.adapters.get(resolved.adapter);
        if (!adapter?.updateCard || !message.messageId) {
            const error = `Adapter "${resolved.adapter}" does not support card updates`;
            this.log?.('card_update_failed', { adapter: resolved.adapter, error }, 'ERROR');
            return { ok: false, error };
        }
        try {
            await adapter.updateCard(message.messageId, message.card);
            this.log?.('card_update_ok', { adapter: resolved.adapter, messageId: message.messageId });
            return { ok: true };
        }
        catch (error) {
            const cardError = errorMessage(error);
            this.log?.('card_update_failed', {
                adapter: resolved.adapter,
                messageId: message.messageId,
                error: cardError,
            }, 'ERROR');
            return { ok: false, error: cardError };
        }
    }
    list() {
        const result = [];
        for (const [name, adapter] of this.adapters) {
            result.push({ name, type: 'adapter', direction: adapter.direction });
        }
        for (const [name, route] of this.routes) {
            result.push({
                name,
                type: 'route',
                adapter: route.adapter,
                target: `${route.adapter} -> ${route.recipient}`,
                ...(route.name ? { label: route.name } : {}),
            });
        }
        return result;
    }
    getErrors() {
        return [...this.errors];
    }
    resolveTarget(adapterName, recipient) {
        const route = this.routes.get(adapterName);
        if (!route)
            return { adapter: adapterName, recipient };
        return { adapter: route.adapter, recipient: recipient || route.recipient };
    }
    resolve(adapterName, recipient) {
        return this.resolveTarget(adapterName, recipient);
    }
}
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
//# sourceMappingURL=registry.js.map