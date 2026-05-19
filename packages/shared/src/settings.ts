import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [name, ...rest] = expr.split(':-');
      const fallback = rest.join(':-');
      const envVal = process.env[name!];
      if (envVal !== undefined && envVal !== '') return envVal;
      return fallback;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

function readSettingsSection<T>(filePath: string, key: string): Partial<T> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return resolveEnvVars(parsed[key] ?? {}) as Partial<T>;
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
