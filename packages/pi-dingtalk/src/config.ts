import { loadPiSettings } from '@amaster.ai/pi-shared/settings';

export type DingTalkConfig = {
  clientId?: string;
  clientSecret?: string;
};

const SETTINGS_KEY = 'pi-dingtalk';

export function loadDingTalkConfig(
  cwd: string,
  projectTrusted = false,
): DingTalkConfig | undefined {
  const config = loadPiSettings<DingTalkConfig>(SETTINGS_KEY, { cwd, projectTrusted });
  if (!config || (!config.clientId && !config.clientSecret)) return undefined;
  return config;
}
