import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../types.js';

// Mock the provider creation for platform mode tests
vi.mock('../provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.js')>();
  return {
    ...actual,
    createMem0Provider: vi.fn(),
  };
});

let mockedHome: string;
vi.mock('@amaster.ai/pi-shared/settings', () => ({
  resolveHome: () => mockedHome,
}));

import { dedupMemories } from '../dedup.js';
import { createMem0Provider, SqliteSnapshotStore } from '../provider.js';

const mockCreateProvider = vi.mocked(createMem0Provider);

function makeItem(id: string, memory: string, updated_at?: string): MemoryItem {
  return { id, memory, updated_at };
}

function mockProviderWith(items: MemoryItem[]) {
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  mockCreateProvider.mockResolvedValue({
    add: vi.fn(),
    search: vi.fn(),
    getAll: vi.fn().mockResolvedValue(items),
    delete: deleteMock,
    flushSnapshot: vi.fn().mockResolvedValue(undefined),
  });
  return { deleteMock };
}

describe('dedupMemories — platform mode', () => {
  it('returns zero duplicates for empty store', async () => {
    mockProviderWith([]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({ total: 0, duplicatesRemoved: 0 });
  });

  it('returns zero duplicates when all entries are unique', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs'),
      makeItem('2', 'Project uses TypeScript'),
      makeItem('3', 'Timezone is UTC+8'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 0 });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('deletes exact duplicates (case-insensitive), keeps newest', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('2', 'user prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('3', 'Project uses TypeScript'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 1 });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith('1');
  });

  it('keeps the most recently updated entry among multiple duplicates', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('old', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('new', 'User prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('oldest', 'user prefers tabs', '2025-01-01T00:00:00Z'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 2 });
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledWith('old');
    expect(deleteMock).toHaveBeenCalledWith('oldest');
  });

  it('continues on individual delete failures and counts only successes', async () => {
    const deleteMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined);
    mockCreateProvider.mockResolvedValue({
      add: vi.fn(),
      search: vi.fn(),
      getAll: vi
        .fn()
        .mockResolvedValue([
          makeItem('1', 'hello', '2026-01-01T00:00:00Z'),
          makeItem('2', 'hello', '2026-06-01T00:00:00Z'),
          makeItem('3', 'hello', '2026-06-10T00:00:00Z'),
        ]),
      delete: deleteMock,
      flushSnapshot: vi.fn().mockResolvedValue(undefined),
    });

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 1 });
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const { deleteMock } = mockProviderWith([
      makeItem('1', 'a', '2026-06-01T10:00:00Z'),
      makeItem('2', 'a', '2026-06-10T10:00:00Z'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'platform', apiKey: 'test' },
      signal: controller.signal,
    });

    expect(result.total).toBe(2);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('dedupMemories — OSS mode (snapshot store)', () => {
  let tempDir: string;

  // Check if better-sqlite3 is available (native binary compiled)
  const hasSqlite = (() => {
    try {
      const testDir = join(tmpdir(), `pi-dedup-sqlite-check-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      const store = SqliteSnapshotStore.tryCreate(join(testDir, 'test.db'));
      if (!store) return false;
      store.close();
      rmSync(testDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  })();

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-dedup-oss-test-${Date.now()}`);
    mkdirSync(join(tempDir, 'memories'), { recursive: true });
    mockedHome = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedSnapshot(items: MemoryItem[]) {
    const dbPath = join(tempDir, 'memories', 'mem0-snapshot.db');
    const store = SqliteSnapshotStore.tryCreate(dbPath)!;
    store.replaceAll('test-user', items);
    store.close();
    return dbPath;
  }

  it.skipIf(!hasSqlite)('returns zero for empty snapshot', async () => {
    seedSnapshot([]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'open-source' },
    });

    expect(result).toEqual({ total: 0, duplicatesRemoved: 0 });
  });

  it.skipIf(!hasSqlite)('deduplicates and persists to snapshot', async () => {
    const dbPath = seedSnapshot([
      makeItem('1', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('2', 'user prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('3', 'Project uses TypeScript'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'open-source' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 1 });

    const store = SqliteSnapshotStore.tryCreate(dbPath)!;
    const remaining = store.loadAll('test-user');
    store.close();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.id).sort()).toEqual(['2', '3']);
  });

  it.skipIf(!hasSqlite)('handles whitespace normalization', async () => {
    const dbPath = seedSnapshot([
      makeItem('a', 'hello  world', '2026-01-01T00:00:00Z'),
      makeItem('b', 'Hello World', '2026-06-01T00:00:00Z'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'open-source' },
    });

    expect(result).toEqual({ total: 2, duplicatesRemoved: 1 });

    const store = SqliteSnapshotStore.tryCreate(dbPath)!;
    const remaining = store.loadAll('test-user');
    store.close();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('b');
  });

  it.skipIf(!hasSqlite)('no-ops when no duplicates', async () => {
    const dbPath = seedSnapshot([makeItem('1', 'fact one'), makeItem('2', 'fact two')]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'open-source' },
    });

    expect(result).toEqual({ total: 2, duplicatesRemoved: 0 });

    const store = SqliteSnapshotStore.tryCreate(dbPath)!;
    const remaining = store.loadAll('test-user');
    store.close();
    expect(remaining).toHaveLength(2);
  });
});
