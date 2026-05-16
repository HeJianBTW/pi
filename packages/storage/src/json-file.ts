/**
 * Minimal JSON-file persistence helpers.
 *
 * Owns directory creation, missing-file fallbacks, private-file permissions, and
 * atomic-ish JSON writes used by local stores. Keep domain-specific schema and
 * retention behavior in the store modules.
 */

import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const backupPath = jsonBackupPath(filePath);
  try {
    return await readJsonFileStrict<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      try {
        return await readJsonFileStrict<T>(backupPath);
      } catch {
        return fallback;
      }
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = jsonBackupPath(filePath);
  await copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeJsonFile(filePath, value);
  await chmod(filePath, 0o600).catch(() => undefined);
}

function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readFile(filePath, 'utf8').then((content) => JSON.parse(content) as T);
}

function jsonBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}
