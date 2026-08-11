/**
 * pi-memory-mem0 — Passive semantic memory extension powered by Mem0.
 *
 * Modes:
 * - **platform**: Uses Mem0 Cloud API (needs MEM0_API_KEY)
 * - **embedded**: Runs Mem0 OSS in-process
 * - **self-hosted**: Calls a remote Mem0 OSS REST server
 *
 * After each conversation turn, user + assistant messages are sent to Mem0
 * for fact extraction and storage (credentials are redacted first). Recalled
 * memories are injected as a custom message (delivered to the model on the
 * user channel, never the system prompt) and wrapped as untrusted data.
 *
 * Configuration via settings.json key "pi-memory-mem0".
 * Supports ${ENV_VAR:-fallback} in user and agent settings.
 * Trusted project settings are loaded without environment interpolation.
 */

import { isProjectTrusted, loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Prefetch } from './prefetch.js';
import { formatRecalledMemory, redactMemoryText, scopeMemoryUserId } from './privacy.js';
import { createMem0Provider, type Mem0Provider, normalizeMem0Mode } from './provider.js';
import type { Mem0ExtensionConfig, MemoryUserIdScope } from './types.js';

const SETTINGS_KEY = 'pi-memory-mem0';
const STATUS_KEY = 'mem0';

function loadConfig(cwd: string, projectTrusted = false): Mem0ExtensionConfig {
  try {
    return loadPiSettings<Mem0ExtensionConfig>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
    });
  } catch {
    return {};
  }
}

function resolveUserId(configUserId?: string, scope: MemoryUserIdScope = 'project'): string {
  if (configUserId?.trim()) return configUserId.trim();
  if (scope === 'exact') throw new Error('Mem0 exact userId resolved to an empty value.');
  if (process.env.USER) return process.env.USER;
  if (process.env.USERNAME) return process.env.USERNAME;
  return 'default-user';
}

export default function mem0Extension(pi: ExtensionAPI): void {
  let provider: Mem0Provider | undefined;
  let prefetch: Prefetch | undefined;
  let userId = '';
  let activeMode = '';
  let lastUserText = '';
  let pendingWrite: Promise<void> = Promise.resolve();

  pi.on('session_start', async (_event, ctx) => {
    provider = undefined;
    prefetch = undefined;
    const config = loadConfig(ctx.cwd, isProjectTrusted(ctx));
    try {
      const mode = normalizeMem0Mode(config.mode);
      if (mode === 'platform' && !config.apiKey?.trim()) {
        ctx.ui.setStatus(STATUS_KEY, 'mem0: disabled (no API key)');
        return;
      }
      const resolvedUserId = resolveUserId(config.userId, config.userIdScope);
      provider = await createMem0Provider({
        config,
        resolveProvider: async (providerName: string) => {
          const registry = ctx.modelRegistry as {
            find?: (
              provider: string,
              modelId: string,
            ) => { baseUrl?: string; api?: string } | undefined;
            getAll?: () => Array<{ provider: string; baseUrl?: string; api?: string }>;
            getApiKeyForProvider?: (p: string) => Promise<string | undefined>;
          };
          if (!registry.getApiKeyForProvider) return undefined;

          let model: { baseUrl?: string; api?: string } | undefined;
          if (registry.getAll) {
            model = registry.getAll().find((m) => m.provider === providerName);
          }

          const apiKey = await registry.getApiKeyForProvider(providerName);
          if (!apiKey && !model) return undefined;
          const result: Record<string, string> = {};
          if (apiKey) result.apiKey = apiKey;
          if (model?.baseUrl) result.baseUrl = model.baseUrl;
          if (model?.api) result.api = model.api as string;
          return result;
        },
      });
      userId = scopeMemoryUserId(resolvedUserId, ctx.cwd, config.userIdScope);
      activeMode = mode;
      prefetch = new Prefetch(provider, userId, { topK: config.topK ?? 5 });
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, 'mem0: init failed');
      ctx.ui.notify(
        `Mem0 init failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, `mem0: ${activeMode}`);
  });

  pi.on('input', async (event) => {
    if (!prefetch) return;
    const text = event.text ?? '';
    if (text) {
      prefetch.queue(text);
      lastUserText = text;
    }
  });

  pi.on('turn_end', async (event) => {
    if (!provider || !lastUserText) return;

    const msg = event.message as { role?: string; content?: unknown };
    const text = extractText(msg);
    if (!text || msg.role !== 'assistant') return;

    const userText = lastUserText;
    lastUserText = '';
    const activeProvider = provider;
    const activeUserId = userId;
    pendingWrite = pendingWrite
      .catch(() => {})
      .then(async () => {
        await activeProvider.add(
          [
            { role: 'user', content: redactMemoryText(userText) },
            { role: 'assistant', content: redactMemoryText(text) },
          ],
          { userId: activeUserId },
        );
      })
      .catch(() => {});
  });

  pi.on('before_agent_start', async () => {
    if (!prefetch) return;

    const recalled = await prefetch.consume();
    if (!recalled) return;

    return {
      message: {
        customType: 'mem0-recall',
        content: recalled,
        display: true,
      },
    };
  });

  pi.on('session_shutdown', async () => {
    await pendingWrite;
    provider = undefined;
    prefetch = undefined;
    lastUserText = '';
    pendingWrite = Promise.resolve();
  });

  pi.registerCommand('mem0', {
    description: 'Mem0 memory commands. Subcommands: status, search <query>, profile.',
    handler: async (args, ctx) => {
      if (!provider) {
        ctx.ui.notify('Mem0 is not active.', 'warning');
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = parts[0]?.toLowerCase() ?? 'status';
      const rest = parts.slice(1).join(' ').trim();

      switch (subcommand) {
        case 'status': {
          ctx.ui.notify(`Mem0: active (mode: ${activeMode})`, 'info');
          break;
        }
        case 'search': {
          if (!rest) {
            ctx.ui.notify('Usage: /mem0 search <query>', 'warning');
            break;
          }
          const results = await provider.search(rest, {
            userId,
            topK: 10,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (results.length === 0) {
            ctx.ui.notify('No relevant memories found.', 'info');
          } else {
            const lines = results.map((r, i) => `${i + 1}. ${formatRecalledMemory(r.memory)}`);
            ctx.ui.notify(`Mem0 search results:\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        case 'profile': {
          const all = await provider.getAll({
            userId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (all.length === 0) {
            ctx.ui.notify('No memories stored yet.', 'info');
          } else {
            const lines = all.map((m, i) => `${i + 1}. ${formatRecalledMemory(m.memory)}`);
            ctx.ui.notify(`Mem0 memories (${all.length}):\n${lines.join('\n')}`, 'info');
          }
          break;
        }
        default:
          ctx.ui.notify('Unknown subcommand. Available: status, search, profile.', 'warning');
      }
    },
  });
}

function extractText(msg: { content?: unknown }): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
  }
  return '';
}
