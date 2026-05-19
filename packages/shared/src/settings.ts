import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function readSettingsSection<T>(filePath: string, key: string): Partial<T> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed[key] ?? {}) as Partial<T>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Load extension config from pi-agent settings files.
 * Reads from user (~/.pi/agent/settings.json) and project (<cwd>/.pi/settings.json),
 * with project-level fields taking priority.
 */
export function loadPiSettings<T>(key: string): T {
  const userSettings = readSettingsSection<T>(
    join(homedir(), '.pi', 'agent', 'settings.json'),
    key,
  );
  const projectSettings = readSettingsSection<T>(
    resolve(process.cwd(), '.pi', 'settings.json'),
    key,
  );
  return { ...userSettings, ...projectSettings } as T;
}
