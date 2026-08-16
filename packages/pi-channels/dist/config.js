import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadPiSettings, resolveConfigDir } from '@amaster.ai/pi-shared/settings';
const SETTINGS_KEY = 'pi-channels';
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function section(settings) {
    const value = settings[SETTINGS_KEY];
    return isRecord(value) ? value : {};
}
function readSettingsFile(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function writeSettingsFile(path, settings) {
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
function discoverLocalSettingsFiles(cwd, projectTrusted) {
    if (!projectTrusted)
        return [];
    const found = [];
    const seen = new Set();
    const add = (path) => {
        const resolved = resolve(path);
        if (seen.has(resolved) || !existsSync(resolved))
            return;
        seen.add(resolved);
        found.push(resolved);
    };
    let current = resolve(cwd);
    const upwards = [];
    while (true) {
        upwards.push(join(current, '.pi', 'settings.json'));
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    for (const path of upwards.reverse())
        add(path);
    return found;
}
function mergeChannelConfig(base, override) {
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
export function loadChannelConfig(cwd, projectTrusted = false) {
    const config = loadPiSettings(SETTINGS_KEY, { cwd, projectTrusted });
    const settingsFiles = discoverLocalSettingsFiles(cwd, projectTrusted);
    const local = settingsFiles.reduce((merged, path) => mergeChannelConfig(merged, section(readSettingsFile(path))), {});
    const merged = mergeChannelConfig(config, local);
    applyEnvOverrides(merged);
    if (process.env.DEBUG?.includes('pi-channels')) {
        console.error('[pi-channels] config', {
            cwd,
            settingsFiles,
            adapters: Object.keys(merged.adapters ?? {}),
            routes: Object.keys(merged.routes ?? {}),
            bridgeEnabled: Boolean(merged.bridge?.enabled),
        });
    }
    return merged;
}
export function updateLocalChannelConfig(cwd, update, projectTrusted = false) {
    const agentSettingsFile = join(resolveConfigDir(), 'settings.json');
    const settingsFile = discoverLocalSettingsFiles(cwd, projectTrusted).at(-1) ??
        (existsSync(agentSettingsFile) ? agentSettingsFile : undefined);
    if (!settingsFile)
        return false;
    const settings = readSettingsFile(settingsFile);
    const current = section(settings);
    const next = update(current);
    settings[SETTINGS_KEY] = next;
    writeSettingsFile(settingsFile, settings);
    return true;
}
function applyEnvOverrides(config) {
    if (process.env.FEISHU_APP_ID || process.env.FEISHU_APP_SECRET) {
        config.adapters ??= {};
        config.adapters.feishu ??= { type: 'feishu' };
        if (process.env.FEISHU_APP_ID)
            config.adapters.feishu.appId = process.env.FEISHU_APP_ID;
        if (process.env.FEISHU_APP_SECRET) {
            config.adapters.feishu.appSecret = process.env.FEISHU_APP_SECRET;
        }
    }
    if (process.env.WECOM_BOT_ID || process.env.WECOM_BOT_SECRET) {
        config.adapters ??= {};
        config.adapters.wecom ??= { type: 'wecom' };
        if (process.env.WECOM_BOT_ID)
            config.adapters.wecom.botId = process.env.WECOM_BOT_ID;
        if (process.env.WECOM_BOT_SECRET)
            config.adapters.wecom.secret = process.env.WECOM_BOT_SECRET;
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
//# sourceMappingURL=config.js.map