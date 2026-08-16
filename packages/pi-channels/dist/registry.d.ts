import type { AdapterConfig, AdapterDirection, ChannelAdapter, ChannelConfig, ChannelMessage, OnIncomingMessage, SendResult } from './types.js';
export type AdapterFactoryContext = {
    cwd: string;
    log?: (event: string, data?: Record<string, unknown>, level?: string) => void;
};
export declare class ChannelRegistry {
    private adapters;
    private adapterFingerprints;
    private routes;
    private errors;
    private onIncoming;
    private log?;
    setLogger(log: (event: string, data?: Record<string, unknown>, level?: string) => void): void;
    setOnIncoming(onIncoming: OnIncomingMessage): void;
    loadConfig(config: ChannelConfig, cwd: string): Promise<void>;
    loadRoutes(config: ChannelConfig): void;
    loadAdapter(name: string, config: AdapterConfig, cwd: string): Promise<void>;
    ensureAdapter(name: string, config: ChannelConfig, cwd: string): Promise<void>;
    startListening(adapterName?: string): Promise<void>;
    stopAll(): Promise<void>;
    register(name: string, adapter: ChannelAdapter): void;
    unregister(name: string): boolean;
    send(message: ChannelMessage): Promise<SendResult>;
    getAdapter(name: string): ChannelAdapter | undefined;
    list(): Array<{
        name: string;
        type: 'adapter' | 'route';
        adapter?: string;
        direction?: AdapterDirection;
        target?: string;
        label?: string;
    }>;
    getErrors(): Array<{
        adapter: string;
        error: string;
    }>;
    resolveTarget(adapterName: string, recipient: string): {
        adapter: string;
        recipient: string;
    };
    private resolve;
}
export declare function errorMessage(error: unknown): string;
//# sourceMappingURL=registry.d.ts.map