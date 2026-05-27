import path from 'node:path';
import { loadPiSettings, resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const SETTINGS_KEY = 'pi-memory';
const STATUS_KEY = 'pi-memory';

export type PiMemoryExtensionConfig = {
  /** Directory containing MEMORY.md / USER.md. Default: `<agentDir>/memories`. */
  dataDir?: string;
  /** Char limit for MEMORY.md. Default 2200. */
  memoryCharLimit?: number;
  /** Char limit for USER.md. Default 1375. */
  userCharLimit?: number;
  /** Pre-built store (host-controlled mode). */
  store?: MemoryStore;
};

type ResolvedConfig = {
  dataDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  store?: MemoryStore;
};

function resolveConfig(raw?: PiMemoryExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveAgentDir(), 'memories'),
  };
  if (raw?.memoryCharLimit !== undefined) resolved.memoryCharLimit = raw.memoryCharLimit;
  if (raw?.userCharLimit !== undefined) resolved.userCharLimit = raw.userCharLimit;
  if (raw?.store) resolved.store = raw.store;
  return resolved;
}

function loadSettings(cwd: string): PiMemoryExtensionConfig | undefined {
  try {
    const config = loadPiSettings<Partial<PiMemoryExtensionConfig>>(SETTINGS_KEY, {
      cwd,
      agentDir: resolveAgentDir(),
    });
    return Object.keys(config).length > 0 ? (config as PiMemoryExtensionConfig) : undefined;
  } catch {
    return undefined;
  }
}

export default function memoryExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiMemoryExtensionConfig,
): void {
  let store: MemoryStore | undefined;
  let snapshot = '';

  pi.on('session_start', async (_event, ctx) => {
    const fileConfig = loadSettings(ctx.cwd);
    const config = resolveConfig({ ...fileConfig, ...injectedConfig });

    try {
      if (config.store) {
        store = config.store;
      } else {
        const opts: ConstructorParameters<typeof MemoryStore>[0] = { dir: config.dataDir };
        if (config.memoryCharLimit !== undefined) opts.memoryCharLimit = config.memoryCharLimit;
        if (config.userCharLimit !== undefined) opts.userCharLimit = config.userCharLimit;
        store = new MemoryStore(opts);
      }
      await store.loadFromDisk();
      snapshot = store.formatAllForSystemPrompt();

      ctx.ui.setStatus(STATUS_KEY, snapshot ? 'memory: loaded' : 'memory: empty');

      for (const tool of createMemoryTools(store)) {
        pi.registerTool(tool);
      }
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, 'memory: unavailable');
      // Surface as a notification only — registration failure shouldn't crash the session.
      ctx.ui.notify(
        `pi-memory failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  });

  pi.on('before_agent_start', async (event) => {
    if (!snapshot) return undefined;
    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${snapshot}` : snapshot,
    };
  });

  pi.on('session_shutdown', async () => {
    store = undefined;
    snapshot = '';
  });

  pi.registerCommand('pi-memory-status', {
    description: 'Show pi-memory status (entry counts and char usage).',
    handler: async (_args, ctx) => {
      if (!store) {
        ctx.ui.notify('pi-memory is not loaded.', 'warning');
        return;
      }
      const memEntries = store.getEntries('memory');
      const userEntries = store.getEntries('user');
      ctx.ui.notify(
        `MEMORY.md: ${memEntries.length} entries\nUSER.md: ${userEntries.length} entries`,
        'info',
      );
    },
  });
}
