/**
 * Algorithmic deduplication for pi-memory-mem0 vector store.
 *
 * Normalizes content, identifies exact duplicates (case-insensitive, whitespace-collapsed),
 * deletes the older entries, and keeps only the most recently updated.
 *
 * Two code paths:
 * - Platform mode: getAll → delete each duplicate via cloud API (IDs are stable)
 * - OSS mode: operate directly on SqliteSnapshotStore (mem0 OSS reassigns IDs on restore)
 */
import { join } from 'node:path';
import { resolveHome } from '@amaster.ai/pi-shared/settings';
import { createMem0Provider, type ProviderResolver, SqliteSnapshotStore } from './provider.js';
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
  const { config } = opts;
  const mode = config.mode ?? 'platform';

  if (mode === 'open-source') {
    return dedupOss(opts);
  }
  return dedupPlatform(opts);
}

/**
 * Platform mode: use provider API (cloud IDs are stable).
 */
async function dedupPlatform(opts: DedupOptions): Promise<DedupResult> {
  const { userId, config, resolveProvider, signal } = opts;

  const provider = await createMem0Provider({
    config,
    ...(resolveProvider ? { resolveProvider } : {}),
  });
  const allMemories = await provider.getAll({ userId });

  if (allMemories.length === 0) {
    return { total: 0, duplicatesRemoved: 0 };
  }

  const duplicateIds = findDuplicateIds(allMemories, signal);

  let removed = 0;
  for (const id of duplicateIds) {
    if (signal?.aborted) break;
    try {
      await provider.delete(id);
      removed++;
    } catch {
      // best-effort
    }
  }

  return { total: allMemories.length, duplicatesRemoved: removed };
}

/**
 * OSS mode: operate directly on the SQLite snapshot store.
 * mem0 OSS reassigns internal IDs when restoring memories, so we can't
 * rely on provider.delete(originalId). Instead, we deduplicate the snapshot
 * in-place and write back the unique set.
 */
function dedupOss(opts: DedupOptions): DedupResult {
  const { userId, config, signal } = opts;

  const snapshotDbPath =
    config.oss?.snapshotDbPath ?? join(resolveHome(), 'memories', 'mem0-snapshot.db');

  const snapshot = SqliteSnapshotStore.tryCreate(snapshotDbPath);
  if (!snapshot) {
    return { total: 0, duplicatesRemoved: 0 };
  }

  try {
    const allItems = snapshot.loadAll(userId) as MemoryItem[];
    if (allItems.length === 0) {
      return { total: 0, duplicatesRemoved: 0 };
    }

    const seen = new Map<string, MemoryItem>();
    let duplicateCount = 0;

    for (const item of allItems) {
      if (signal?.aborted) break;

      const normalized = item.memory.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
      const existing = seen.get(normalized);

      if (existing) {
        const existingTime = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const currentTime = item.updated_at ? new Date(item.updated_at).getTime() : 0;
        if (currentTime > existingTime) {
          seen.set(normalized, item);
        }
        duplicateCount++;
      } else {
        seen.set(normalized, item);
      }
    }

    if (duplicateCount > 0) {
      const uniqueItems = [...seen.values()];
      snapshot.replaceAll(userId, uniqueItems);
    }

    return { total: allItems.length, duplicatesRemoved: duplicateCount };
  } finally {
    snapshot.close();
  }
}

/**
 * Shared: find IDs of duplicate entries to remove (keeps the newest).
 */
function findDuplicateIds(allMemories: MemoryItem[], signal?: AbortSignal): string[] {
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

  return duplicateIds;
}
