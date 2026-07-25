import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

export type LarkConfig = {
  appId?: string;
  appSecret?: string;
  domain?: 'feishu' | 'lark' | string;
};

const SETTINGS_KEY = 'pi-lark';

export function loadLarkConfig(cwd: string, projectTrusted = false): LarkConfig | undefined {
  const config = loadPiSettings<LarkConfig>(SETTINGS_KEY, { cwd, projectTrusted });
  if (!config || (!config.appId && !config.appSecret)) return undefined;
  return config;
}
