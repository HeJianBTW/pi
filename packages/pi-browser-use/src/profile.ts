import { accessSync, constants, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserUseConfig, DEFAULT_PROFILE_DIR } from './config.js';

// Files Chrome must be able to read and write; if any is inaccessible (e.g.
// owned by root after the profile was created via sudo), Chrome shows a
// "can't read your preferences" dialog and silently drops preference changes.
const REQUIRED_PROFILE_FILES = ['Local State', join('Default', 'Preferences')];

function isReadableWritable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInaccessiblePath(userDataDir: string): string | undefined {
  if (!isUsableDirectory(userDataDir)) return userDataDir;
  const defaultDir = join(userDataDir, 'Default');
  if (existsSync(defaultDir) && !isUsableDirectory(defaultDir)) return defaultDir;
  for (const file of REQUIRED_PROFILE_FILES) {
    const path = join(userDataDir, file);
    if (existsSync(path) && !isReadableWritable(path)) return path;
  }
  return undefined;
}

function inaccessibleProfileError(
  userDataDir: string,
  inaccessiblePath: string,
  moveFailed = false,
): Error {
  return new Error(
    `Chrome profile at ${JSON.stringify(userDataDir)} is not readable/writable by the current user ` +
      `(${JSON.stringify(inaccessiblePath)})${moveFailed ? ' and could not be moved aside' : ''}. ` +
      'Restore ownership and read/write permissions for that profile, then retry.',
  );
}

/**
 * Verify Chrome can read and write its profile before launch.
 *
 * When the profile is unusable (typically files owned by another user after a
 * sudo-run browser), the managed default profile is moved aside so Chrome
 * starts fresh — nothing is deleted. For a custom userDataDir we refuse to
 * touch the directory and throw with a remediation hint instead.
 */
function ensureProfileAccessible(userDataDir: string, allowRelocate: boolean): void {
  if (!existsSync(userDataDir)) return;

  const inaccessiblePath = findInaccessiblePath(userDataDir);
  if (!inaccessiblePath) return;

  if (!allowRelocate) {
    throw inaccessibleProfileError(userDataDir, inaccessiblePath);
  }

  const movedTo = `${userDataDir}.inaccessible-${Date.now()}`;
  try {
    renameSync(userDataDir, movedTo);
  } catch {
    if (!existsSync(userDataDir)) return;
    throw inaccessibleProfileError(userDataDir, inaccessiblePath, true);
  }
  console.error(
    `[pi-browser-use] Chrome profile at ${JSON.stringify(userDataDir)} was not readable/writable ` +
      `by the current user; moved it to ${JSON.stringify(movedTo)} and will create a fresh profile.`,
  );
}

export function prepareBrowserProfile(
  config: BrowserUseConfig,
  managedProfileDir = DEFAULT_PROFILE_DIR,
): void {
  const userDataDir = config.userDataDir;
  if (
    config.sessionMode !== 'persistent' ||
    !userDataDir ||
    config.browserUrl ||
    config.wsEndpoint ||
    config.autoConnect
  ) {
    return;
  }
  ensureProfileAccessible(userDataDir, userDataDir === managedProfileDir);
}
