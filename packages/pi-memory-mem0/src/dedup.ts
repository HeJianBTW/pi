/**
 * Algorithmic deduplication for pi-memory-mem0 vector store.
 *
 * Normalizes content, identifies exact duplicates (case-insensitive, whitespace-collapsed),
 * deletes the older entries, and keeps only the most recently updated.
 */
import { createMem0Provider, type ProviderResolver } from './provider.js';
import type { Mem0ExtensionConfig, MemoryItem } from './types.js';

export interface DedupOptions {
  userId: string;
  config: Mem0ExtensionConfig;
  resolveProvider?: ProviderResolver;
  signal?: AbortSignal;
}

export interface DedupResult {
  total: number;
  duplicatesRemoved: number;
}

export async function dedupMemories(opts: DedupOptions): Promise<DedupResult> {
  const { userId, config, resolveProvider, signal } = opts;

  const provider = await createMem0Provider({
    config,
    ...(resolveProvider ? { resolveProvider } : {}),
  });
  const allMemories = await provider.getAll({ userId });

  if (allMemories.length === 0) {
    return { total: 0, duplicatesRemoved: 0 };
  }

  const seen = new Map<string, MemoryItem>();
  const duplicateIds: string[] = [];

  for (const item of allMemories) {
    if (signal?.aborted) break;

    const normalized = item.memory.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    const existing = seen.get(normalized);

    if (existing) {
      const existingTime = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
      const currentTime = item.updated_at ? new Date(item.updated_at).getTime() : 0;
      if (currentTime > existingTime) {
        duplicateIds.push(existing.id);
        seen.set(normalized, item);
      } else {
        duplicateIds.push(item.id);
      }
    } else {
      seen.set(normalized, item);
    }
  }

  // Actually delete the duplicates
  let removed = 0;
  for (const id of duplicateIds) {
    if (signal?.aborted) break;
    try {
      await provider.delete(id);
      removed++;
    } catch {
      // best-effort: skip failures on individual deletes
    }
  }

  // Persist the deletions to the SQLite snapshot so they survive process restart
  if (removed > 0) {
    await provider.flushSnapshot(userId);
  }

  return { total: allMemories.length, duplicatesRemoved: removed };
}
