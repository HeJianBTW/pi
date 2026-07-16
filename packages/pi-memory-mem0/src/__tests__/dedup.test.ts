import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../types.js';

// Mock provider creation so both modes exercise the same public abstraction.
vi.mock('../provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.js')>();
  return {
    ...actual,
    createMem0Provider: vi.fn(),
  };
});

import { dedupMemories } from '../dedup.js';
import { createMem0Provider } from '../provider.js';

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
  });
  return { deleteMock };
}

describe('dedupMemories', () => {
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
  it('uses stable vector-store IDs in OSS mode', async () => {
    const { deleteMock } = mockProviderWith([
      makeItem('1', 'User prefers tabs', '2026-06-01T10:00:00Z'),
      makeItem('2', 'user prefers tabs', '2026-06-10T10:00:00Z'),
      makeItem('3', 'Project uses TypeScript'),
    ]);

    const result = await dedupMemories({
      userId: 'test-user',
      config: { mode: 'open-source' },
    });

    expect(result).toEqual({ total: 3, duplicatesRemoved: 1 });
    expect(deleteMock).toHaveBeenCalledWith('1');
    expect(mockCreateProvider).toHaveBeenCalledWith({ config: { mode: 'open-source' } });
  });
});
