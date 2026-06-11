/**
 * Mem0 provider abstraction — supports both Platform (cloud) and OSS (local SQLite) modes.
 *
 * Uses the `mem0ai` npm SDK which handles:
 * - Platform mode: REST API calls to api.mem0.ai
 * - OSS mode: local SQLite vector store + LLM extraction via configured provider
 */

import { join } from 'node:path';
import { resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { AddResult, Mem0ExtensionConfig, MemoryItem } from './types.js';

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

export interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; infer?: boolean },
  ): Promise<AddResult | null>;

  search(query: string, opts: { userId: string; topK?: number }): Promise<MemoryItem[]>;

  getAll(opts: { userId: string }): Promise<MemoryItem[]>;
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeMemoryItem(raw: Record<string, unknown>): MemoryItem {
  return {
    id: String(raw.id ?? raw.memory_id ?? ''),
    memory: String(raw.memory ?? raw.text ?? raw.content ?? ''),
    score: typeof raw.score === 'number' ? raw.score : undefined,
    user_id: raw.user_id as string | undefined,
    created_at: (raw.created_at ?? raw.createdAt) as string | undefined,
    updated_at: (raw.updated_at ?? raw.updatedAt) as string | undefined,
  };
}

function normalizeResults(raw: unknown): MemoryItem[] {
  if (Array.isArray(raw))
    return raw.map((item) => normalizeMemoryItem(item as Record<string, unknown>));
  if (
    raw &&
    typeof raw === 'object' &&
    'results' in raw &&
    Array.isArray((raw as { results: unknown }).results)
  ) {
    return (raw as { results: unknown[] }).results.map((item) =>
      normalizeMemoryItem(item as Record<string, unknown>),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Platform Provider
// ---------------------------------------------------------------------------

class PlatformProvider implements Mem0Provider {
  private client: unknown;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl?: string,
  ) {}

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { MemoryClient } = await import('mem0ai');
    const opts: Record<string, unknown> = { apiKey: this.apiKey };
    if (this.baseUrl) opts.host = this.baseUrl;
    this.client = new MemoryClient(opts as never);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; infer?: boolean },
  ): Promise<AddResult | null> {
    await this.ensureClient();
    const addOpts: Record<string, unknown> = { userId: opts.userId };
    if (opts.infer === false) addOpts.infer = false;
    const result = await (this.client as any).add(messages, addOpts);
    return result as AddResult;
  }

  async search(query: string, opts: { userId: string; topK?: number }): Promise<MemoryItem[]> {
    await this.ensureClient();
    const searchOpts: Record<string, unknown> = {
      filters: { user_id: opts.userId },
    };
    if (opts.topK) searchOpts.topK = opts.topK;
    const results = await (this.client as any).search(query, searchOpts);
    return normalizeResults(results);
  }

  async getAll(opts: { userId: string }): Promise<MemoryItem[]> {
    await this.ensureClient();
    const results = await (this.client as any).getAll({
      filters: { user_id: opts.userId },
    });
    return normalizeResults(results);
  }
}

// ---------------------------------------------------------------------------
// Open-Source Provider (local SQLite)
// ---------------------------------------------------------------------------

/** Optional key resolver — pulls API keys from pi's model registry. */
export type KeyResolver = (provider: string) => Promise<string | undefined>;

class OSSProvider implements Mem0Provider {
  private memory: unknown;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig: Mem0ExtensionConfig['oss'] | undefined,
    private readonly resolveKey?: KeyResolver,
  ) {}

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _buildConfig(): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {};

    const defaultEmbedder = { provider: 'openai', config: { model: 'text-embedding-3-small' } };
    const defaultLlm = { provider: 'openai', config: { model: 'gpt-4.1-nano' } };

    const embedderProvider = this.ossConfig?.embedder?.provider || defaultEmbedder.provider;
    const embedderCfg: Record<string, unknown> = {
      ...defaultEmbedder.config,
      ...(this.ossConfig?.embedder?.config ?? {}),
    };

    const llmProvider = this.ossConfig?.llm?.provider || defaultLlm.provider;
    const llmCfg: Record<string, unknown> = {
      ...defaultLlm.config,
      ...(this.ossConfig?.llm?.config ?? {}),
    };

    // Resolve API keys from pi model registry if not explicitly set
    if (this.resolveKey) {
      if (!embedderCfg.apiKey && !embedderCfg.api_key) {
        const key = await this.resolveKey(embedderProvider);
        if (key) embedderCfg.apiKey = key;
      }
      if (!llmCfg.apiKey && !llmCfg.api_key) {
        const key = await this.resolveKey(llmProvider);
        if (key) llmCfg.apiKey = key;
      }
    }

    config.embedder = { provider: embedderProvider, config: embedderCfg };
    config.llm = { provider: llmProvider, config: llmCfg };

    if (this.ossConfig?.vectorStore) {
      config.vectorStore = this.ossConfig.vectorStore;
    } else {
      // Default: SQLite in <PI_AGENT_HOME>/memories/mem0.db (alongside pi-memory's files)
      config.vectorStore = {
        provider: 'sqlite',
        config: { dbPath: join(resolveAgentDir(), 'memories', 'mem0.db') },
      };
    }

    if (this.ossConfig?.disableHistory) {
      config.disableHistory = true;
    }

    return config;
  }

  private async _init(): Promise<void> {
    const mod = await import('mem0ai/oss');
    const Memory = (mod as any).Memory ?? (mod as any).default;
    const builtConfig = await this._buildConfig();
    this.memory = new Memory(builtConfig);
    await (this.memory as any).getAll({ filters: { user_id: '__warmup__' } });
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    opts: { userId: string; infer?: boolean },
  ): Promise<AddResult | null> {
    await this.ensureMemory();
    const addOpts: Record<string, unknown> = { userId: opts.userId };
    if (opts.infer === false) addOpts.infer = false;
    const result = await (this.memory as any).add(messages, addOpts);
    return result as AddResult;
  }

  async search(query: string, opts: { userId: string; topK?: number }): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const searchOpts: Record<string, unknown> = {
      filters: { user_id: opts.userId },
    };
    if (opts.topK) searchOpts.topK = opts.topK;
    const results = await (this.memory as any).search(query, searchOpts);
    return normalizeResults(results);
  }

  async getAll(opts: { userId: string }): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const results = await (this.memory as any).getAll({
      filters: { user_id: opts.userId },
    });
    return normalizeResults(results);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateProviderOptions {
  config: Mem0ExtensionConfig;
  /** Resolve API key from pi model registry by provider name. */
  resolveKey?: KeyResolver;
}

export async function createMem0Provider(opts: CreateProviderOptions): Promise<Mem0Provider> {
  const { config, resolveKey } = opts;
  const mode = config.mode ?? 'platform';

  if (mode === 'open-source') {
    const useRegistry = config.useRegistryKeys !== false;
    const provider = new OSSProvider(config.oss, useRegistry ? resolveKey : undefined);
    await (provider as any).ensureMemory();
    return provider;
  }

  if (!config.apiKey?.trim()) {
    throw new Error('Platform mode requires apiKey.');
  }
  return new PlatformProvider(config.apiKey.trim(), config.baseUrl?.trim());
}
