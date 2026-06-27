import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process and os/fs so we don't actually touch the system scheduler
const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

let mockedHome: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockedHome,
  };
});

describe('scheduler', () => {
  let tempDir: string;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-scheduler-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mockedHome = tempDir;
    execFileSyncMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
      originalPlatform = undefined;
    }
  });

  function setPlatform(platform: string) {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  }

  describe('darwin (launchd)', () => {
    beforeEach(() => setPlatform('darwin'));

    it('install writes plist and calls launchctl load', async () => {
      const { install } = await import('../scheduler.js');

      await install({
        name: 'ai.pi.test-job',
        command: '/usr/bin/node',
        args: ['/path/to/script.js', '--once'],
        intervalSeconds: 14400,
        description: 'Test job',
      });

      const plistDir = join(tempDir, 'Library', 'LaunchAgents');
      const plistPath = join(plistDir, 'ai.pi.test-job.plist');
      expect(existsSync(plistPath)).toBe(true);

      const content = readFileSync(plistPath, 'utf-8');
      expect(content).toContain('<string>ai.pi.test-job</string>');
      expect(content).toContain('<string>/usr/bin/node</string>');
      expect(content).toContain('<string>/path/to/script.js</string>');
      expect(content).toContain('<string>--once</string>');
      expect(content).toContain('<integer>14400</integer>');

      expect(execFileSyncMock).toHaveBeenCalledWith('launchctl', ['load', '-w', plistPath], {
        stdio: 'ignore',
      });
    });

    it('uninstall calls launchctl unload and removes plist', async () => {
      const { install, uninstall } = await import('../scheduler.js');

      await install({
        name: 'ai.pi.test-job',
        command: '/usr/bin/node',
        args: ['/path/to/script.js'],
        intervalSeconds: 3600,
      });

      execFileSyncMock.mockReset();
      await uninstall('ai.pi.test-job');

      const plistPath = join(tempDir, 'Library', 'LaunchAgents', 'ai.pi.test-job.plist');
      expect(existsSync(plistPath)).toBe(false);
      expect(execFileSyncMock).toHaveBeenCalledWith('launchctl', ['unload', plistPath], {
        stdio: 'ignore',
      });
    });

    it('status returns installed when plist exists', async () => {
      const { install, status } = await import('../scheduler.js');

      expect(await status('ai.pi.test-job')).toBe('not-found');

      await install({
        name: 'ai.pi.test-job',
        command: '/usr/bin/node',
        args: ['script.js'],
        intervalSeconds: 7200,
      });

      expect(await status('ai.pi.test-job')).toBe('installed');
    });

    it('uninstall is no-op when plist does not exist', async () => {
      const { uninstall } = await import('../scheduler.js');
      await uninstall('ai.pi.nonexistent');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('linux (crontab)', () => {
    beforeEach(() => setPlatform('linux'));

    it('install appends tagged line to crontab', async () => {
      execFileSyncMock.mockReturnValue('');
      const { install } = await import('../scheduler.js');

      await install({
        name: 'ai.pi.test-job',
        command: '/usr/bin/node',
        args: ['/path/to/script.js', '--once'],
        intervalSeconds: 14400, // 4 hours
      });

      expect(execSyncMock).toHaveBeenCalledTimes(1);
      const written = execSyncMock.mock.calls[0]?.[0] as string;
      expect(written).toContain('# @pi-scheduler:ai.pi.test-job');
      expect(written).toContain('/usr/bin/node /path/to/script.js --once');
      expect(written).toContain('0 */4 * * *');
    });

    it('uninstall removes tagged line from crontab', async () => {
      execFileSyncMock.mockReturnValue(
        '0 */4 * * * /usr/bin/node script.js # @pi-scheduler:ai.pi.test-job\n' +
          '0 * * * * /other/job\n',
      );
      const { uninstall } = await import('../scheduler.js');
      await uninstall('ai.pi.test-job');

      const written = execSyncMock.mock.calls[0]?.[0] as string;
      expect(written).not.toContain('ai.pi.test-job');
      expect(written).toContain('/other/job');
    });

    it('status returns installed when tag exists in crontab', async () => {
      execFileSyncMock.mockReturnValue(
        '0 */4 * * * /usr/bin/node script.js # @pi-scheduler:ai.pi.test-job\n',
      );
      const { status } = await import('../scheduler.js');
      expect(await status('ai.pi.test-job')).toBe('installed');
    });

    it('status returns not-found when no matching tag', async () => {
      execFileSyncMock.mockReturnValue('0 * * * * /other/job\n');
      const { status } = await import('../scheduler.js');
      expect(await status('ai.pi.test-job')).toBe('not-found');
    });
  });

  describe('win32 (schtasks)', () => {
    beforeEach(() => setPlatform('win32'));

    it('install calls schtasks /create', async () => {
      const { install } = await import('../scheduler.js');

      await install({
        name: 'ai.pi.test-job',
        command: 'node',
        args: ['C:\\path\\script.js'],
        intervalSeconds: 14400, // 240 minutes
      });

      expect(execFileSyncMock).toHaveBeenCalledWith(
        'schtasks',
        expect.arrayContaining(['/create', '/tn', 'ai.pi.test-job', '/mo', '240']),
        { stdio: 'ignore' },
      );
    });

    it('uninstall calls schtasks /delete', async () => {
      const { uninstall } = await import('../scheduler.js');
      await uninstall('ai.pi.test-job');

      expect(execFileSyncMock).toHaveBeenCalledWith(
        'schtasks',
        ['/delete', '/tn', 'ai.pi.test-job', '/f'],
        { stdio: 'ignore' },
      );
    });

    it('status returns installed when schtasks /query succeeds', async () => {
      execFileSyncMock.mockReturnValue('');
      const { status } = await import('../scheduler.js');
      expect(await status('ai.pi.test-job')).toBe('installed');
    });

    it('status returns not-found when schtasks /query throws', async () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error('task not found');
      });
      const { status } = await import('../scheduler.js');
      expect(await status('ai.pi.test-job')).toBe('not-found');
    });
  });

  describe('unsupported platform', () => {
    it('install throws on unsupported platform', async () => {
      setPlatform('freebsd');
      const { install } = await import('../scheduler.js');
      await expect(install({ name: 'test', command: 'echo', intervalSeconds: 60 })).rejects.toThrow(
        'Unsupported platform',
      );
    });
  });
});
