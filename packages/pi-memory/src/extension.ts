import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, status, uninstall } from '@amaster.ai/pi-shared/scheduler';
import { loadPiSettings, resolveHome } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createExtractionRunner,
  type ExtractionModelConfig,
  type ExtractionRunner,
} from './background-extraction.js';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  /** Dreaming (periodic consolidation + dedup) config. */
  dreaming?: DreamingConfig;
};

export type DreamingConfig = {
  /** Set to false to disable dreaming entirely and unregister the cron job. Default: true. */
  enabled?: boolean;
  /** Interval in hours between dream runs. Default: 4. */
  intervalHours?: number;
};

type ResolvedConfig = {
  dataDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  store?: MemoryStore;
  extractionModel?: ExtractionModelConfig;
  extractionInterval: number;
  dreaming?: DreamingConfig;
};

function resolveConfig(raw?: PiMemoryExtensionConfig): ResolvedConfig {
  const resolved: ResolvedConfig = {
    dataDir: raw?.dataDir?.trim() || path.join(resolveHome(), 'memories'),
    extractionInterval: raw?.extractionInterval ?? 5,
  };
  if (raw?.memoryCharLimit !== undefined) resolved.memoryCharLimit = raw.memoryCharLimit;
  if (raw?.userCharLimit !== undefined) resolved.userCharLimit = raw.userCharLimit;
  if (raw?.store) resolved.store = raw.store;
  if (raw?.extractionModel) resolved.extractionModel = raw.extractionModel;
  if (raw?.dreaming) resolved.dreaming = raw.dreaming;
  return resolved;
}

function loadSettings(cwd: string): PiMemoryExtensionConfig | undefined {
  try {
    const config = loadPiSettings<Partial<PiMemoryExtensionConfig>>(SETTINGS_KEY, {
      cwd,
    });
    return Object.keys(config).length > 0 ? (config as PiMemoryExtensionConfig) : undefined;
  } catch {
    return undefined;
  }
}

const DREAM_JOB_NAME = 'ai.pi.memory-dream';
const DEFAULT_DREAM_INTERVAL_HOURS = 4;

async function registerDreamingCron(dreaming?: DreamingConfig): Promise<void> {
  try {
    if (dreaming?.enabled === false) {
      const current = await status(DREAM_JOB_NAME);
      if (current === 'installed') {
        await uninstall(DREAM_JOB_NAME);
      }
      return;
    }

    const current = await status(DREAM_JOB_NAME);
    if (current === 'installed') return;

    const dreamBin = path.resolve(__dirname, 'cli/dream.js');
    const intervalHours = dreaming?.intervalHours ?? DEFAULT_DREAM_INTERVAL_HOURS;
    await install({
      name: DREAM_JOB_NAME,
      command: process.execPath,
      args: [dreamBin, '--once'],
      intervalSeconds: intervalHours * 3600,
      description: 'Pi memory consolidation and dedup',
    });
  } catch {
    // Non-fatal: cron registration failure should not block the extension
  }
}

export default function memoryExtension(
  pi: ExtensionAPI,
  injectedConfig?: PiMemoryExtensionConfig,
): void {
  let store: MemoryStore | undefined;
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
      const snapshot = store.formatAllForSystemPrompt();

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

      // Auto-register dreaming cron job
      await registerDreamingCron(config.dreaming);
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
    if (store) {
      await store.loadFromDisk();
    }
    const snapshot = store?.formatAllForSystemPrompt() ?? '';
    const block = snapshot ? `${MEMORY_GUIDANCE}\n\n${snapshot}` : MEMORY_GUIDANCE;
    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${block}` : block,
    };
  });

  pi.on('session_shutdown', async () => {
    extractionRunner?.shutdown();
    extractionRunner = undefined;
    store = undefined;
  });

  pi.registerCommand('memory', {
    description: 'Manage persistent memory. Subcommands: status, read, add, replace, remove.',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['status', 'read', 'add', 'replace', 'remove'];
      const matches = subcommands.filter((s) => s.startsWith(prefix.trim().toLowerCase()));
      return matches.map((s) => ({ label: s, value: s }));
    },
    handler: async (args, ctx) => {
      if (!store) {
        ctx.ui.notify('pi-memory is not loaded.', 'warning');
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          const memResult = await store.read('memory');
          const userResult = await store.read('user');
          ctx.ui.notify(
            `MEMORY.md: ${memResult.entryCount} entries (${memResult.usage})\nUSER.md: ${userResult.entryCount} entries (${userResult.usage})`,
            'info',
          );
          break;
        }

        case 'read': {
          const target = rest === 'user' ? 'user' : 'memory';
          const result = await store.read(target as 'memory' | 'user');
          if (result.entries.length === 0) {
            ctx.ui.notify(`${target}: (empty)`, 'info');
          } else {
            ctx.ui.notify(
              `${target} [${result.usage}]:\n${result.entries.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
              'info',
            );
          }
          break;
        }

        case 'add': {
          if (!rest) {
            ctx.ui.notify('Usage: /memory add [user|memory] <content>', 'warning');
            break;
          }
          const addParts = rest.split(/\s+/);
          let target: 'memory' | 'user' = 'memory';
          let content = rest;
          if (addParts[0] === 'user' || addParts[0] === 'memory') {
            target = addParts[0] as 'memory' | 'user';
            content = addParts.slice(1).join(' ');
          }
          if (!content) {
            ctx.ui.notify('Usage: /memory add [user|memory] <content>', 'warning');
            break;
          }
          const addResult = await store.add(target, content);
          ctx.ui.notify(
            addResult.success ? `Added to ${target}.` : `Failed: ${addResult.error}`,
            addResult.success ? 'info' : 'warning',
          );
          break;
        }

        case 'replace': {
          // Format: /memory replace [target] <oldText> -> <newContent>
          if (!rest?.includes('->')) {
            ctx.ui.notify(
              'Usage: /memory replace [user|memory] <oldText> -> <newContent>',
              'warning',
            );
            break;
          }
          const replaceParts = rest.split(/\s+/);
          let rTarget: 'memory' | 'user' = 'memory';
          let replaceBody = rest;
          if (replaceParts[0] === 'user' || replaceParts[0] === 'memory') {
            rTarget = replaceParts[0] as 'memory' | 'user';
            replaceBody = replaceParts.slice(1).join(' ');
          }
          const [oldText, newContent] = replaceBody.split('->').map((s) => s.trim());
          if (!oldText || !newContent) {
            ctx.ui.notify(
              'Usage: /memory replace [user|memory] <oldText> -> <newContent>',
              'warning',
            );
            break;
          }
          const replaceResult = await store.replace(rTarget, oldText, newContent);
          ctx.ui.notify(
            replaceResult.success ? `Replaced in ${rTarget}.` : `Failed: ${replaceResult.error}`,
            replaceResult.success ? 'info' : 'warning',
          );
          break;
        }

        case 'remove': {
          if (!rest) {
            ctx.ui.notify('Usage: /memory remove [user|memory] <substring>', 'warning');
            break;
          }
          const rmParts = rest.split(/\s+/);
          let rmTarget: 'memory' | 'user' = 'memory';
          let rmText = rest;
          if (rmParts[0] === 'user' || rmParts[0] === 'memory') {
            rmTarget = rmParts[0] as 'memory' | 'user';
            rmText = rmParts.slice(1).join(' ');
          }
          if (!rmText) {
            ctx.ui.notify('Usage: /memory remove [user|memory] <substring>', 'warning');
            break;
          }
          const rmResult = await store.remove(rmTarget, rmText);
          ctx.ui.notify(
            rmResult.success ? `Removed from ${rmTarget}.` : `Failed: ${rmResult.error}`,
            rmResult.success ? 'info' : 'warning',
          );
          break;
        }

        default:
          ctx.ui.notify(
            'Unknown subcommand. Available: status, read, add, replace, remove.',
            'warning',
          );
      }
    },
  });
}
