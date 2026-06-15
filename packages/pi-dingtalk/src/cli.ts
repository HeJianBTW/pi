import { exec, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DingTalkConfig } from './config.js';

const NPM_PACKAGE = 'dingtalk-workspace-cli';

export function isDwsInstalled(): boolean {
  try {
    execSync('dws --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installDws(): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`npm install -g ${NPM_PACKAGE}@latest`, (error) => {
      if (error) reject(new Error(`Failed to install ${NPM_PACKAGE}: ${error.message}`));
      else resolve();
    });
  });
}

export async function ensureDws(): Promise<boolean> {
  if (isDwsInstalled()) return true;
  await installDws();
  return isDwsInstalled();
}

export function initDws(config: DingTalkConfig): void {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) {
    throw new Error('clientId and clientSecret are required');
  }
  execSync(`dws auth login --client-id "${clientId}" --client-secret "${clientSecret}" --yes`, {
    stdio: 'pipe',
  });
}

export function getDwsSkillsDir(): string | undefined {
  try {
    const npmRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const skillsPath = join(npmRoot, 'dingtalk-workspace-cli', 'skills', 'multi');
    if (existsSync(skillsPath)) return skillsPath;
  } catch {
    // ignore
  }
  return undefined;
}
