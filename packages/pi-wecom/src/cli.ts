import { exec, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NPM_PACKAGE = '@wecom/cli';

export function isWeComCliInstalled(): boolean {
  try {
    execSync('wecom-cli --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installWeComCli(): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`npm install -g ${NPM_PACKAGE}@latest`, (error) => {
      if (error) reject(new Error(`Failed to install ${NPM_PACKAGE}: ${error.message}`));
      else resolve();
    });
  });
}

export async function ensureWeComCli(): Promise<boolean> {
  if (isWeComCliInstalled()) return true;
  await installWeComCli();
  return isWeComCliInstalled();
}

export function isWeComCliAuthenticated(): boolean {
  try {
    const output = execSync('wecom-cli auth status', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return !output.includes('not authenticated') && !output.includes('未认证');
  } catch {
    return false;
  }
}

export function getWeComCliSkillsDir(): string | undefined {
  try {
    const npmRoot = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const skillsPath = join(npmRoot, '@wecom', 'cli', 'skills');
    if (existsSync(skillsPath)) return skillsPath;
  } catch {
    // ignore
  }
  return undefined;
}
