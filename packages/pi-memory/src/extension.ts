import path from 'node:path';
import { loadPiSettings, resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createExtractionRunner,
  type ExtractionModelConfig,
  type ExtractionRunner,
} from './background-extraction.js';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const SETTINGS_KEY = 'pi-memory';
const STATUS_KEY = 'pi-memory';

const MEMORY_GUIDANCE = [
  '# Memory Guidance',
  '',
  'You have persistent memory across sessions via the memory_add / memory_replace / memory_remove / memory_read tools.',
  'Save durable facts: user preferences, environment details, tool quirks, and stable conventions.',
  'Memory is injected into every turn, so keep it compact and focused on facts that will still matter later.',
  '',
  'Prioritize what reduces future user steering — the most valuable memory is one that prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.',
  '',
  "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state. Specifically: do not record PR numbers, issue numbers, commit SHAs, 'fixed bug X', 'submitted PR Y', 'Phase N done', file counts, or any artifact that will be stale in 7 days. If a fact will be stale in a week, it does not belong in memory.",
  '',
  "Write memories as declarative facts, not instructions to yourself. 'User prefers concise responses' ✓ — 'Always respond concisely' ✗. 'Project uses pytest with xdist' ✓ — 'Run tests with pytest -n 4' ✗. Imperative phrasing gets re-read as a directive in later sessions and can cause repeated work or override the user's current request.",
].join('\n');

export type PiMemoryExtensionConfig = {
  /** Directory containing MEMORY.md / USER.md. Default: `<agentDir>/memories`. */
  dataDir?: string;
  /** Char limit for MEMORY.md. Default 2200. */
  memoryCharLimit?: number;
  /** Char limit for USER.md. Default 1375. */
  userCharLimit?: number;
  /** Pre-built store (host-controlled mode). */
  store?: MemoryStore;
  /** Model for background memory extraction. Omit to disable extraction. */
  extractionModel?: ExtractionModelConfig;
  /** Turns between extraction runs. Default: 5. */
  extractionInterval?: number;
};

type ResolvedConfig = {
  dataDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  store?: MemoryStore;
  extractionModel?: ExtractionModelConfig;
  extractionInterval: number;
};

function resolveConfig(raw?: PiMemoryExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveAgentDir(), 'memories'),
    extractionInterval: raw?.extractionInterval ?? 5,
  };
  if (raw?.memoryCharLimit !== undefined) resolved.memoryCharLimit = raw.memoryCharLimit;
  if (raw?.userCharLimit !== undefined) resolved.userCharLimit = raw.userCharLimit;
  if (raw?.store) resolved.store = raw.store;
  if (raw?.extractionModel) resolved.extractionModel = raw.extractionModel;
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
  let extractionRunner: ExtractionRunner | undefined;

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

      if (config.extractionModel && store) {
        extractionRunner = createExtractionRunner({
          store,
          modelConfig: config.extractionModel,
          interval: config.extractionInterval,
          modelRegistry: ctx.modelRegistry as never,
          onNotify: (msg, level) => ctx.ui.notify(msg, level),
        });
      }
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, 'memory: unavailable');
      ctx.ui.notify(
        `pi-memory failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  });

  pi.on('turn_end', async (event) => {
    if (!extractionRunner) return;
    extractionRunner.onTurnEnd(event as never);
  });

  pi.on('before_agent_start', async (event) => {
    const block = snapshot ? `${MEMORY_GUIDANCE}\n\n${snapshot}` : MEMORY_GUIDANCE;
    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${block}` : block,
    };
  });

  pi.on('session_shutdown', async () => {
    extractionRunner?.shutdown();
    extractionRunner = undefined;
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
