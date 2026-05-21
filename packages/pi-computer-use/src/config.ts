import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface VisionModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ComputerUseConfig {
  /** 'bundled' uses the packaged binary, 'path' uses a custom binary path */
  mode?: 'bundled' | 'path';
  /** Custom cua-driver binary path (used when mode is 'path') */
  binaryPath?: string;
  /** Extra CLI args passed to cua-driver mcp */
  extraArgs?: string[];
  /** Vision model for screenshot analysis */
  visionModel?: VisionModelConfig;
}

const DEFAULTS: Partial<ComputerUseConfig> = {
  mode: 'bundled',
};

export function resolveConfig(config?: ComputerUseConfig): ComputerUseConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(options?: PiSettingsOptions): ComputerUseConfig {
  return loadPiSettings<ComputerUseConfig>('pi-computer-use', {
    agentDir: getAgentDir(),
    ...options,
  });
}
