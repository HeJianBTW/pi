import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export type PiSettingsOptions = {
  cwd?: string;
  agentDir?: string;
};

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

export function resolveAgentDir(override?: string): string {
  return resolve(override ?? process.env.PI_AGENT_HOME ?? join(homedir(), '.pi', 'agent'));
}

/**
 * Load extension config from pi-agent settings files.
 * Reads from global (~/.pi/agent/settings.json), agentDir (env/param), and project (<cwd>/.pi/settings.json).
 * Priority from low to high: global < agentDir < project.
 */
export function loadPiSettings<T>(key: string, options?: PiSettingsOptions): T {
  const globalDir = resolve(join(homedir(), '.pi', 'agent'));
  const agentDir = resolveAgentDir(options?.agentDir);
  const cwd = options?.cwd ?? process.cwd();

  const globalSettings = readSettingsSection<T>(join(globalDir, 'settings.json'), key);

  const agentSettings =
    agentDir === globalDir
      ? ({} as Partial<T>)
      : readSettingsSection<T>(join(agentDir, 'settings.json'), key);

  const projectSettings = readSettingsSection<T>(join(cwd, '.pi', 'settings.json'), key);

  return { ...globalSettings, ...agentSettings, ...projectSettings } as T;
}

export function loadJsonProfileDir<T>(dir: string): Record<string, T> {
  const result: Record<string, T> = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = basename(entry, '.json');
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result[name] = parsed as T;
      }
    } catch {
      // skip malformed files
    }
  }
  return result;
}

export function loadPiPolicyProfiles<T>(options?: PiSettingsOptions): Record<string, T> {
  const globalDir = resolve(join(homedir(), '.pi', 'agent', 'policy'));
  const agentDir = resolve(join(resolveAgentDir(options?.agentDir), 'policy'));
  const projectDir = resolve(join(options?.cwd ?? process.cwd(), '.pi', 'policy'));

  const globalPolicies = loadJsonProfileDir<T>(globalDir);
  const agentPolicies =
    agentDir === globalDir ? ({} as Record<string, T>) : loadJsonProfileDir<T>(agentDir);
  const projectPolicies = loadJsonProfileDir<T>(projectDir);

  return { ...globalPolicies, ...agentPolicies, ...projectPolicies };
}
