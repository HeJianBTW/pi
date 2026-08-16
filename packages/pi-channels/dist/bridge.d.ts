import type { ChannelRegistry } from './registry.js';
import type { BridgeConfig, IncomingMessage } from './types.js';
export declare class ChatBridge {
    private config;
    private cwd;
    private registry;
    private running;
    private activeCount;
    private sessions;
    constructor(config: BridgeConfig | undefined, cwd: string, registry: ChannelRegistry);
    start(): void;
    stop(): void;
    isActive(): boolean;
    stats(): {
        active: boolean;
        sessions: number;
        activePrompts: number;
        queued: number;
    };
    handleMessage(message: IncomingMessage): Promise<void>;
    private sendProcessingAck;
    private getSession;
    private handleBuiltInCommand;
    private processNext;
    private drainWaiting;
}
//# sourceMappingURL=bridge.d.ts.map