import { loadPiSettings, type PiSettingsOptions } from '@amaster.ai/pi-shared/settings';

export interface VisionModelConfig {
  provider: string;
  model: string;
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
  /** Ask once per app target before launch_app. Default: true */
  confirmAppLaunch?: boolean;
  /** Confirm high-risk tools such as kill_app and replay_trajectory. Default: true */
  confirmDangerousActions?: boolean;
}

const DEFAULTS: Partial<ComputerUseConfig> = {
  mode: 'bundled',
  confirmAppLaunch: true,
  confirmDangerousActions: true,
};

export function resolveConfig(config?: ComputerUseConfig): ComputerUseConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(options?: PiSettingsOptions): ComputerUseConfig {
  return loadPiSettings<ComputerUseConfig>('pi-computer-use', {
    ...options,
  });
}
