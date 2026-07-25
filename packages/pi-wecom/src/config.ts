import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

export type WeComConfig = {
  botId?: string;
  botSecret?: string;
};

const SETTINGS_KEY = 'pi-wecom';

export function loadWeComConfig(cwd: string, projectTrusted = false): WeComConfig | undefined {
  const config = loadPiSettings<WeComConfig>(SETTINGS_KEY, { cwd, projectTrusted });
  if (!config || (!config.botId && !config.botSecret)) return undefined;
  return config;
}
