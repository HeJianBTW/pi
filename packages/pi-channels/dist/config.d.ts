import type { ChannelConfig } from './types.js';
export declare function loadChannelConfig(cwd: string, projectTrusted?: boolean): ChannelConfig;
export declare function updateLocalChannelConfig(cwd: string, update: (config: ChannelConfig) => ChannelConfig, projectTrusted?: boolean): boolean;
//# sourceMappingURL=config.d.ts.map