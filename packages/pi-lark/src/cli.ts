import { exec } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LarkConfig } from './config.js';

const NPM_PACKAGE = '@larksuite/cli';
const INSTALL_DIR = join(homedir(), '.lark-cli');
const BIN_PATH = join(INSTALL_DIR, 'node_modules', '.bin', 'lark-cli');

let installAttempted = false;
let cliAvailable: boolean | undefined;

function execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function larkCliBin(): string {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  return 'lark-cli';
}

export async function isLarkCliInstalled(): Promise<boolean> {
  if (cliAvailable !== undefined) return cliAvailable;
  try {
    await execAsync(`"${larkCliBin()}" --version`);
    cliAvailable = true;
    return true;
  } catch {
    cliAvailable = false;
    return false;
  }
}

export async function installLarkCli(): Promise<void> {
  if (installAttempted) return;
  installAttempted = true;
  mkdirSync(INSTALL_DIR, { recursive: true });
  await execAsync(`npm install --prefix "${INSTALL_DIR}" ${NPM_PACKAGE}@latest`);
  cliAvailable = undefined;
}

export async function ensureLarkCli(): Promise<boolean> {
  if (await isLarkCliInstalled()) return true;
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

export async function getLarkCliSkillsDir(): Promise<string | undefined> {
  const bin = larkCliBin();
  try {
    const { stdout } = await execAsync(`"${bin}" skills path`);
    const output = stdout.trim();
    if (output && existsSync(output)) return output;
  } catch {
    // fallback
  }

  const localSkills = join(INSTALL_DIR, 'node_modules', '@larksuite', 'cli', 'skills');
  if (existsSync(localSkills)) return localSkills;

  return undefined;
}

export async function checkLarkCliAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await execAsync(`"${larkCliBin()}" auth status --json`);
    const status = JSON.parse(stdout);
    if (status?.loggedIn || status?.authenticated) return { ok: true };
    return { ok: false, error: 'not authenticated' };
  } catch {
    return { ok: false, error: 'lark-cli auth status failed' };
  }
}
