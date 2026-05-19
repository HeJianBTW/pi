import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ChannelConfig } from './types.js';

const SETTINGS_KEY = 'pi-channels';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [name, ...rest] = expr.split(':-');
      const fallback = rest.join(':-');
      const envVal = process.env[name!];
      return envVal !== undefined && envVal !== '' ? envVal : fallback;
    });
  }
  if (Array.isArray(value)) return value.map(resolveEnvVars);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) result[key] = resolveEnvVars(nested);
    return result;
  }
  return value;
}

function section(settings: Record<string, unknown>): ChannelConfig {
  const value = settings[SETTINGS_KEY];
  return isRecord(value) ? (resolveEnvVars(value) as ChannelConfig) : {};
}

export function loadChannelConfig(cwd: string): ChannelConfig {
  const sm = SettingsManager.create(cwd, getAgentDir());
  const global = section(sm.getGlobalSettings() as Record<string, unknown>);
  const project = section(sm.getProjectSettings() as Record<string, unknown>);

  const config: ChannelConfig = {
    adapters: {
      ...(global.adapters ?? {}),
      ...(project.adapters ?? {}),
    },
    routes: {
      ...(global.routes ?? {}),
      ...(project.routes ?? {}),
    },
    bridge: {
      ...(global.bridge ?? {}),
      ...(project.bridge ?? {}),
    },
  };

  applyEnvOverrides(config);
  return config;
}

function applyEnvOverrides(config: ChannelConfig): void {
  if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
    config.adapters ??= {};
    config.adapters.feishu ??= { type: 'feishu' };
    if (process.env.FEISHU_APP_ID) config.adapters.feishu.appId = process.env.FEISHU_APP_ID;
    if (process.env.FEISHU_APP_SECRET) {
      config.adapters.feishu.appSecret = process.env.FEISHU_APP_SECRET;
    }
  }

  if (process.env.WECOM_CORP_ID || process.env.WECOM_SECRET || process.env.WECOM_AGENT_ID) {
    config.adapters ??= {};
    config.adapters.wecom ??= { type: 'wecom' };
    if (process.env.WECOM_CORP_ID) config.adapters.wecom.corpId = process.env.WECOM_CORP_ID;
    if (process.env.WECOM_SECRET) config.adapters.wecom.secret = process.env.WECOM_SECRET;
    if (process.env.WECOM_AGENT_ID) config.adapters.wecom.agentId = process.env.WECOM_AGENT_ID;
  }

  if (process.env.WEBHOOK_SECRET) {
    config.adapters ??= {};
    config.adapters.webhook ??= { type: 'webhook' };
    config.adapters.webhook.secret = process.env.WEBHOOK_SECRET;
  }
}
