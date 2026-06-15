import { exec, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LarkConfig } from './config.js';

const NPM_PACKAGE = '@larksuite/cli';

export function isLarkCliInstalled(): boolean {
  try {
    execSync('lark-cli --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installLarkCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`npm install -g ${NPM_PACKAGE}@latest`, (error) => {
      if (error) reject(new Error(`Failed to install ${NPM_PACKAGE}: ${error.message}`));
      else resolve();
    });
  });
}

export async function ensureLarkCli(): Promise<boolean> {
  if (isLarkCliInstalled()) return true;
  await installLarkCli();
  return isLarkCliInstalled();
}

export function initLarkCli(config: LarkConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const { appId, appSecret, domain } = config;
    if (!appId || !appSecret) {
      reject(new Error('appId and appSecret are required'));
      return;
    }

    const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR || join(homedir(), '.lark-cli');
    const configFile = join(configDir, 'config.json');

    const brand = domain === 'lark' ? 'lark' : 'feishu';

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { mode: 0o700, recursive: true });
    }

    const configContent = JSON.stringify(
      {
        apps: [
          {
            appId,
            appSecret,
            brand,
            users: [],
          },
        ],
      },
      null,
      2,
    );

    writeFileSync(configFile, `${configContent}\n`, { mode: 0o600 });
    resolve();
  });
}

export function getLarkCliSkillsDir(): string | undefined {
  try {
    const output = execSync('lark-cli skills path', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (output && existsSync(output)) return output;
  } catch {
    // fallback: try to find skills in the npm global package
  }

  try {
    const npmRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const skillsPath = join(npmRoot, '@larksuite', 'cli', 'skills');
    if (existsSync(skillsPath)) return skillsPath;
  } catch {
    // ignore
  }

  return undefined;
}

export function checkLarkCliAuth(): { ok: boolean; error?: string } {
  try {
    const output = execSync('lark-cli auth status --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const status = JSON.parse(output);
    if (status?.loggedIn || status?.authenticated) return { ok: true };
    return { ok: false, error: 'not authenticated' };
  } catch {
    return { ok: false, error: 'lark-cli auth status failed' };
  }
}
