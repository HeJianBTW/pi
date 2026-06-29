/**
 * Cross-platform system scheduled task registration.
 *
 * Supports:
 * - macOS: launchd LaunchAgent (~/Library/LaunchAgents/)
 * - Linux: user crontab (tagged lines)
 * - Windows: Task Scheduler (schtasks)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ScheduleJobConfig {
  name: string;
  /** Executable path (e.g. process.execPath). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  intervalSeconds: number;
  description?: string;
}

export type ScheduleStatus = 'installed' | 'not-found';

export async function install(config: ScheduleJobConfig): Promise<void> {
  const platform = process.platform;
  switch (platform) {
    case 'darwin':
      return installDarwin(config);
    case 'linux':
      return installLinux(config);
    case 'win32':
      return installWin32(config);
    default:
      throw new Error(`Unsupported platform for scheduler: ${platform}`);
  }
}

export async function uninstall(name: string): Promise<void> {
  const platform = process.platform;
  switch (platform) {
    case 'darwin':
      return uninstallDarwin(name);
    case 'linux':
      return uninstallLinux(name);
    case 'win32':
      return uninstallWin32(name);
    default:
      throw new Error(`Unsupported platform for scheduler: ${platform}`);
  }
}

export async function status(name: string): Promise<ScheduleStatus> {
  const platform = process.platform;
  switch (platform) {
    case 'darwin':
      return statusDarwin(name);
    case 'linux':
      return statusLinux(name);
    case 'win32':
      return statusWin32(name);
    default:
      return 'not-found';
  }
}

// ─── macOS (launchd) ────────────────────────────────────────────────────────

function plistPath(name: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
}

function generatePlist(config: ScheduleJobConfig): string {
  const allArgs = [config.command, ...(config.args ?? [])];
  const argsXml = allArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.name)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/${escapeXml(config.name)}.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${escapeXml(config.name)}.stderr.log</string>
</dict>
</plist>`;
}

function installDarwin(config: ScheduleJobConfig): void {
  const filePath = plistPath(config.name);
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });

  // Unload existing if present
  if (existsSync(filePath)) {
    try {
      execFileSync('launchctl', ['unload', filePath], { stdio: 'ignore' });
    } catch {
      // may not be loaded
    }
  }

  writeFileSync(filePath, generatePlist(config), 'utf-8');
  execFileSync('launchctl', ['load', '-w', filePath], { stdio: 'ignore' });
}

function uninstallDarwin(name: string): void {
  const filePath = plistPath(name);
  if (!existsSync(filePath)) return;
  try {
    execFileSync('launchctl', ['unload', filePath], { stdio: 'ignore' });
  } catch {
    // may not be loaded
  }
  unlinkSync(filePath);
}

function statusDarwin(name: string): ScheduleStatus {
  const filePath = plistPath(name);
  if (!existsSync(filePath)) return 'not-found';
  try {
    execFileSync('launchctl', ['list', name], { stdio: 'ignore' });
    return 'installed';
  } catch {
    // plist exists but not loaded
    return 'not-found';
  }
}

// ─── Linux (crontab) ────────────────────────────────────────────────────────

const CRON_TAG_PREFIX = '# @pi-scheduler:';

function intervalToCron(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `0 */${hours} * * *`;
  return `0 0 */${Math.round(hours / 24)} * *`;
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], { input: content, stdio: ['pipe', 'ignore', 'inherit'] });
}

function installLinux(config: ScheduleJobConfig): void {
  const tag = `${CRON_TAG_PREFIX}${config.name}`;
  const cronExpr = intervalToCron(config.intervalSeconds);
  const fullCommand = buildPosixCommand(config);
  const line = `${cronExpr} ${fullCommand} ${tag}`;

  let current = readCrontab();
  // Remove existing entry for this name
  current = current
    .split('\n')
    .filter((l) => !l.includes(`${CRON_TAG_PREFIX}${config.name}`))
    .join('\n');

  const newContent = `${current.trimEnd()}\n${line}\n`;
  writeCrontab(newContent);
}

function uninstallLinux(name: string): void {
  const current = readCrontab();
  const filtered = current
    .split('\n')
    .filter((l) => !l.includes(`${CRON_TAG_PREFIX}${name}`))
    .join('\n');
  writeCrontab(filtered);
}

function statusLinux(name: string): ScheduleStatus {
  const current = readCrontab();
  return current.includes(`${CRON_TAG_PREFIX}${name}`) ? 'installed' : 'not-found';
}

// ─── Windows (Task Scheduler) ───────────────────────────────────────────────

function installWin32(config: ScheduleJobConfig): void {
  // Delete existing if present
  try {
    execFileSync('schtasks', ['/delete', '/tn', config.name, '/f'], { stdio: 'ignore' });
  } catch {
    // task may not exist
  }

  const fullCommand = buildWin32Command(config);
  const minutes = Math.max(1, Math.round(config.intervalSeconds / 60));
  const hours = Math.round(minutes / 60);
  // schtasks /mo limits: minute 1-1439, hourly 1-23, daily 1-365
  let sc: string;
  let mo: string;
  if (minutes < 60) {
    sc = 'minute';
    mo = String(minutes);
  } else if (hours < 24) {
    sc = 'hourly';
    mo = String(hours);
  } else {
    sc = 'daily';
    mo = String(Math.max(1, Math.round(hours / 24)));
  }

  execFileSync(
    'schtasks',
    ['/create', '/tn', config.name, '/tr', fullCommand, '/sc', sc, '/mo', mo, '/f'],
    { stdio: 'ignore' },
  );
}

function uninstallWin32(name: string): void {
  try {
    execFileSync('schtasks', ['/delete', '/tn', name, '/f'], { stdio: 'ignore' });
  } catch {
    // task may not exist
  }
}

function statusWin32(name: string): ScheduleStatus {
  try {
    execFileSync('schtasks', ['/query', '/tn', name], { stdio: 'ignore' });
    return 'installed';
  } catch {
    return 'not-found';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildPosixCommand(config: ScheduleJobConfig): string {
  const parts = [config.command, ...(config.args ?? [])];
  return parts.map(shellEscape).join(' ');
}

function buildWin32Command(config: ScheduleJobConfig): string {
  const parts = [config.command, ...(config.args ?? [])];
  // Windows cmd: quote args containing spaces with double quotes
  return parts.map((s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)).join(' ');
}
