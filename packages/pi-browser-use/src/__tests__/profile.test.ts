import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareBrowserProfile } from '../profile.js';

function createHealthyProfile(dir: string): void {
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Local State'), '{}');
  writeFileSync(join(dir, 'Default', 'Preferences'), '{}');
}

function relocatedDirs(dir: string): string[] {
  const parent = dirname(dir);
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((entry) => entry.startsWith(`${basename(dir)}.inaccessible-`));
}

describe('prepareBrowserProfile', () => {
  let tmpRoot: string;
  let profileDir: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'pi-browser-use-profile-'));
    profileDir = join(tmpRoot, 'profile');
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    // Restore permissions so cleanup can remove chmod-protected entries.
    try {
      chmodSync(profileDir, 0o700);
    } catch {
      // Directory may not exist or may have been relocated.
    }
    try {
      chmodSync(join(profileDir, 'Default'), 0o700);
    } catch {
      // Directory may not exist or may have been relocated.
    }
    try {
      chmodSync(join(profileDir, 'Default', 'Preferences'), 0o600);
    } catch {
      // File may not exist or may have been relocated.
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does nothing when the profile dir does not exist', () => {
    prepareBrowserProfile({ sessionMode: 'persistent', userDataDir: profileDir }, profileDir);

    expect(existsSync(profileDir)).toBe(false);
  });

  it('does nothing when the profile dir and its files are accessible', () => {
    createHealthyProfile(profileDir);

    prepareBrowserProfile({ sessionMode: 'persistent', userDataDir: profileDir }, profileDir);

    expect(existsSync(join(profileDir, 'Default', 'Preferences'))).toBe(true);
    expect(relocatedDirs(profileDir)).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('moves an inaccessible managed profile aside and logs a warning', () => {
    createHealthyProfile(profileDir);
    chmodSync(join(profileDir, 'Default', 'Preferences'), 0o000);

    prepareBrowserProfile({ sessionMode: 'persistent', userDataDir: profileDir }, profileDir);

    expect(existsSync(profileDir)).toBe(false);
    expect(relocatedDirs(profileDir)).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[pi-browser-use] Chrome profile'),
    );
  });

  it('throws for an inaccessible custom profile without touching it', () => {
    createHealthyProfile(profileDir);
    chmodSync(join(profileDir, 'Default', 'Preferences'), 0o000);

    let message = '';
    try {
      prepareBrowserProfile(
        { sessionMode: 'persistent', userDataDir: profileDir },
        join(tmpRoot, 'managed-profile'),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/not readable\/writable by the current user/);
    expect(message).not.toMatch(/sudo (?:chown|rm)|rm -rf/);

    expect(existsSync(join(profileDir, 'Default', 'Preferences'))).toBe(true);
    expect(relocatedDirs(profileDir)).toHaveLength(0);
  });

  it('treats an inaccessible profile dir itself as broken', () => {
    createHealthyProfile(profileDir);
    chmodSync(profileDir, 0o000);

    expect(() =>
      prepareBrowserProfile(
        { sessionMode: 'persistent', userDataDir: profileDir },
        join(tmpRoot, 'managed-profile'),
      ),
    ).toThrow(/not readable\/writable by the current user/);
  });

  it('treats an unsearchable Default directory as broken', () => {
    createHealthyProfile(profileDir);
    chmodSync(join(profileDir, 'Default'), 0o600);

    expect(() =>
      prepareBrowserProfile(
        { sessionMode: 'persistent', userDataDir: profileDir },
        join(tmpRoot, 'managed-profile'),
      ),
    ).toThrow(/not readable\/writable by the current user/);
  });

  it.each([
    { sessionMode: 'existing' as const },
    { sessionMode: 'isolated' as const },
    { sessionMode: 'persistent' as const, browserUrl: 'http://localhost:9222' },
    { sessionMode: 'persistent' as const, wsEndpoint: 'ws://localhost:9222' },
    { sessionMode: 'persistent' as const, autoConnect: true },
  ])('does not inspect a profile for non-launch config $sessionMode', (config) => {
    createHealthyProfile(profileDir);
    chmodSync(join(profileDir, 'Default'), 0o600);

    expect(() =>
      prepareBrowserProfile({ ...config, userDataDir: profileDir }, profileDir),
    ).not.toThrow();
    expect(existsSync(profileDir)).toBe(true);
  });
});
