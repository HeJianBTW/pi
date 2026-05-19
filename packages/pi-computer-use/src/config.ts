import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

export interface VisionModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ComputerUseConfig {
  /** 'managed' spawns cua-computer-server, 'external' connects to existing */
  mode?: 'managed' | 'external';

  /** Command to start cua-computer-server (default: 'uvx') */
  command?: string;
  /** Package/module to run (default: 'cua-computer-server') */
  package?: string;
  /** Extra CLI args for cua-computer-server */
  extraArgs?: string[];

  /** Server host (default: '127.0.0.1') */
  host?: string;
  /** Server port (default: 8000) */
  port?: number;
  /** API key — enables wss + auth for cloud/remote */
  apiKey?: string;
  /** VM name for cloud routing */
  vmName?: string;

  /** Auto-screenshot after each action (default: true) */
  autoScreenshot?: boolean;
  /** Vision model for screenshot analysis */
  visionModel?: VisionModelConfig;
}

const DEFAULTS: Partial<ComputerUseConfig> = {
  mode: 'managed',
  command: 'uvx',
  package: 'cua-computer-server',
  host: '127.0.0.1',
  port: 8000,
  autoScreenshot: true,
};

export function resolveConfig(config?: ComputerUseConfig): ComputerUseConfig {
  return { ...DEFAULTS, ...config };
}

export function loadConfigFromFile(): ComputerUseConfig {
  return loadPiSettings<ComputerUseConfig>('pi-computer-use');
}
