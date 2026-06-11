import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadPiSettings, resolveConfigDir } from '@amaster.ai/pi-shared/settings';
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

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(path: string, settings: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function discoverLocalSettingsFiles(cwd: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (path: string) => {
    const resolved = resolve(path);
    if (seen.has(resolved) || !existsSync(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };

  const agentDir = resolveConfigDir();
  add(join(agentDir, 'settings.json'));

  let current = resolve(cwd);
  const upwards: string[] = [];
  while (true) {
    upwards.push(join(current, '.pi', 'settings.json'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const path of upwards.reverse()) add(path);
  return found;
}

function mergeChannelConfig(base: ChannelConfig, override: ChannelConfig): ChannelConfig {
  return {
    adapters: {
      ...(base.adapters ?? {}),
      ...(override.adapters ?? {}),
    },
    routes: {
      ...(base.routes ?? {}),
      ...(override.routes ?? {}),
    },
    bridge: {
      ...(base.bridge ?? {}),
      ...(override.bridge ?? {}),
    },
  };
}

export function loadChannelConfig(cwd: string): ChannelConfig {
  const agentDir = resolveConfigDir();
  const config = loadPiSettings<ChannelConfig>(SETTINGS_KEY, { cwd });

  const settingsFiles = discoverLocalSettingsFiles(cwd);
  const local = settingsFiles.reduce(
    (merged, path) => mergeChannelConfig(merged, section(readSettingsFile(path))),
    {} as ChannelConfig,
  );

  const merged = mergeChannelConfig(config, local);

  applyEnvOverrides(merged);
  console.debug('[pi-channels] config', {
    cwd,
    agentDir,
    settingsFiles,
    adapters: Object.keys(merged.adapters ?? {}),
    routes: Object.keys(merged.routes ?? {}),
    bridgeEnabled: Boolean(merged.bridge?.enabled),
  });
  return merged;
}

export function updateLocalChannelConfig(
  cwd: string,
  update: (config: ChannelConfig) => ChannelConfig,
): boolean {
  const settingsFile = discoverLocalSettingsFiles(cwd).at(-1);
  if (!settingsFile) return false;

  const settings = readSettingsFile(settingsFile);
  const current = section(settings);
  const next = update(current);
  settings[SETTINGS_KEY] = next;
  writeSettingsFile(settingsFile, settings);
  return true;
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

  if (process.env.WECOM_BOT_ID || process.env.WECOM_BOT_SECRET) {
    config.adapters ??= {};
    config.adapters.wecom ??= { type: 'wecom' };
    if (process.env.WECOM_BOT_ID) config.adapters.wecom.botId = process.env.WECOM_BOT_ID;
    if (process.env.WECOM_BOT_SECRET) config.adapters.wecom.secret = process.env.WECOM_BOT_SECRET;
  }

  if (process.env.DINGTALK_CLIENT_ID || process.env.DINGTALK_CLIENT_SECRET) {
    config.adapters ??= {};
    config.adapters.dingtalk ??= { type: 'dingtalk' };
    if (process.env.DINGTALK_CLIENT_ID) {
      config.adapters.dingtalk.clientId = process.env.DINGTALK_CLIENT_ID;
    }
    if (process.env.DINGTALK_CLIENT_SECRET) {
      config.adapters.dingtalk.clientSecret = process.env.DINGTALK_CLIENT_SECRET;
    }
    if (process.env.DINGTALK_ROBOT_CODE) {
      config.adapters.dingtalk.robotCode = process.env.DINGTALK_ROBOT_CODE;
    }
  }

  if (process.env.WEBHOOK_SECRET) {
    config.adapters ??= {};
    config.adapters.webhook ??= { type: 'webhook' };
    config.adapters.webhook.secret = process.env.WEBHOOK_SECRET;
  }
}
