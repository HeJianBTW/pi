import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export type PiSettingsOptions = {
  cwd?: string;
  /** Override for the config directory. If not set, resolveConfigDir() is used. */
  configDir?: string;
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

/**
 * Resolve the user data / runtime home directory.
 * Used for: memories, data, skills, logs.
 */
export function resolveHome(override?: string): string {
  return resolve(override ?? process.env.PI_AGENT_HOME ?? join(homedir(), '.pi', 'agent'));
}

/**
 * Resolve the system config directory.
 * Used for: settings.json, policy, auth, models.
 */
export function resolveConfigDir(override?: string): string {
  return resolve(
    override ??
      process.env.PI_CODING_AGENT_DIR ??
      process.env.PI_AGENT_HOME ??
      join(homedir(), '.pi', 'agent'),
  );
}

/** @deprecated Use resolveHome() or resolveConfigDir() instead. */
export function resolveAgentDir(override?: string): string {
  return resolveHome(override);
}

/**
 * Load extension config from pi-agent settings files.
 * Reads from global (~/.pi/agent/settings.json), agentDir (env/param), and project (<cwd>/.pi/settings.json).
 * Priority from low to high: global < agentDir < project.
 */
export function loadPiSettings<T>(key: string, options?: PiSettingsOptions): T {
  const globalDir = resolve(join(homedir(), '.pi', 'agent'));
  const configDir = resolveConfigDir(options?.configDir);
  const cwd = options?.cwd ?? process.cwd();

  const globalSettings = readSettingsSection<T>(join(globalDir, 'settings.json'), key);

  const configSettings =
    configDir === globalDir
      ? ({} as Partial<T>)
      : readSettingsSection<T>(join(configDir, 'settings.json'), key);

  const projectSettings = readSettingsSection<T>(join(cwd, '.pi', 'settings.json'), key);

  return { ...globalSettings, ...configSettings, ...projectSettings } as T;
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
  const configPolicyDir = resolve(join(resolveConfigDir(options?.configDir), 'policy'));
  const projectDir = resolve(join(options?.cwd ?? process.cwd(), '.pi', 'policy'));

  const globalPolicies = loadJsonProfileDir<T>(globalDir);
  const configPolicies =
    configPolicyDir === globalDir
      ? ({} as Record<string, T>)
      : loadJsonProfileDir<T>(configPolicyDir);
  const projectPolicies = loadJsonProfileDir<T>(projectDir);

  return { ...globalPolicies, ...configPolicies, ...projectPolicies };
}
