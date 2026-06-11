import { describe, expect, it, vi } from 'vitest';
import { Prefetch } from './prefetch.js';
import type { KeyResolver, Mem0Provider } from './provider.js';
import { TurnSync } from './sync.js';
import { createMem0Tools } from './tools.js';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function mockProvider(overrides: Partial<Mem0Provider> = {}): Mem0Provider {
  return {
    add: vi.fn().mockResolvedValue({ results: [] }),
    search: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TurnSync
// ---------------------------------------------------------------------------

describe('TurnSync', () => {
  it('syncs user+assistant pairs', async () => {
    const provider = mockProvider();
    const sync = new TurnSync(provider, 'user-1');

    sync.onMessage('user', 'hello');
    sync.onMessage('assistant', 'hi there');

    await new Promise((r) => setTimeout(r, 50));

    expect(provider.add).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      { userId: 'user-1' },
    );
  });

  it('does not sync assistant without preceding user message', async () => {
    const provider = mockProvider();
    const sync = new TurnSync(provider, 'u');

    sync.onMessage('assistant', 'unprompted');

    await new Promise((r) => setTimeout(r, 50));
    expect(provider.add).not.toHaveBeenCalled();
  });

  it('drops concurrent syncs', async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const provider = mockProvider({
      add: vi.fn().mockImplementationOnce(async () => {
        await first;
        return { results: [] };
      }),
    });
    const sync = new TurnSync(provider, 'u');

    sync.onMessage('user', 'a');
    sync.onMessage('assistant', 'b');
    sync.onMessage('user', 'c');
    sync.onMessage('assistant', 'd');

    resolveFirst();
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.add).toHaveBeenCalledTimes(1);
  });

  it('syncs again after first completes', async () => {
    const provider = mockProvider();
    const sync = new TurnSync(provider, 'u');

    sync.onMessage('user', 'a');
    sync.onMessage('assistant', 'b');
    await new Promise((r) => setTimeout(r, 50));

    sync.onMessage('user', 'c');
    sync.onMessage('assistant', 'd');
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.add).toHaveBeenCalledTimes(2);
  });

  it('handles provider errors gracefully', async () => {
    const provider = mockProvider({
      add: vi.fn().mockRejectedValue(new Error('network')),
    });
    const sync = new TurnSync(provider, 'u');

    sync.onMessage('user', 'a');
    sync.onMessage('assistant', 'b');
    await new Promise((r) => setTimeout(r, 50));

    // Should not throw, inflight resets
    sync.onMessage('user', 'c');
    sync.onMessage('assistant', 'd');
    await new Promise((r) => setTimeout(r, 50));

    expect(provider.add).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

describe('Prefetch', () => {
  it('queue + consume returns formatted memories', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([
        { id: '1', memory: 'likes TypeScript' },
        { id: '2', memory: 'uses vim' },
      ]),
    });
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    pf.queue('preferences');
    const result = await pf.consume();

    expect(result).toContain('## Recalled Memories (Mem0)');
    expect(result).toContain('- likes TypeScript');
    expect(result).toContain('- uses vim');
    expect(provider.search).toHaveBeenCalledWith('preferences', { userId: 'u', topK: 5 });
  });

  it('returns empty string when nothing queued', async () => {
    const provider = mockProvider();
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    const result = await pf.consume();
    expect(result).toBe('');
  });

  it('returns empty on timeout', async () => {
    const provider = mockProvider({
      search: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    pf.queue('test');
    const result = await pf.consume(50);

    expect(result).toBe('');
  });

  it('returns empty when search returns no results', async () => {
    const provider = mockProvider({ search: vi.fn().mockResolvedValue([]) });
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    pf.queue('nothing');
    const result = await pf.consume();

    expect(result).toBe('');
  });

  it('filters out empty memory strings', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([
        { id: '1', memory: 'valid' },
        { id: '2', memory: '' },
        { id: '3', memory: '  ' },
      ]),
    });
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    pf.queue('q');
    const result = await pf.consume();

    expect(result).toContain('- valid');
    expect(result).not.toContain('- \n');
    expect(result.match(/^-/gm)?.length).toBe(1);
  });

  it('clears pending after consume', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([{ id: '1', memory: 'fact' }]),
    });
    const pf = new Prefetch(provider, 'u', { topK: 5 });

    pf.queue('q');
    await pf.consume();
    const second = await pf.consume();

    expect(second).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('createMem0Tools', () => {
  it('exposes 3 tools', () => {
    const tools = createMem0Tools(mockProvider(), 'u');
    expect(tools.map((t) => t.name)).toEqual(['mem0_search', 'mem0_profile', 'mem0_save']);
  });
});

describe('mem0_search tool', () => {
  async function run(provider: Mem0Provider, params: Record<string, unknown>) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_search')!;
    const result = await tool.execute('c', params);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('returns search results', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([{ id: '1', memory: 'likes cats', score: 0.9 }]),
    });
    const result = await run(provider, { query: 'pets' });
    expect(result.results).toEqual([{ memory: 'likes cats', score: 0.9 }]);
  });

  it('rejects empty query', async () => {
    const result = await run(mockProvider(), { query: '' });
    expect(result.error).toContain('empty');
  });

  it('caps top_k at 50', async () => {
    const provider = mockProvider();
    await run(provider, { query: 'test', top_k: 100 });
    expect(provider.search).toHaveBeenCalledWith('test', { userId: 'u', topK: 50 });
  });

  it('handles provider error', async () => {
    const provider = mockProvider({
      search: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const result = await run(provider, { query: 'test' });
    expect(result.error).toContain('fail');
  });
});

describe('mem0_save tool', () => {
  async function run(provider: Mem0Provider, params: Record<string, unknown>) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_save')!;
    const result = await tool.execute('c', params);
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('stores a fact with infer=false', async () => {
    const provider = mockProvider({
      add: vi.fn().mockResolvedValue({ results: [{ id: '1', memory: 'fact', event: 'ADD' }] }),
    });
    const result = await run(provider, { fact: 'user prefers dark mode' });
    expect(result.result).toBe('Fact stored.');
    expect(provider.add).toHaveBeenCalledWith(
      [{ role: 'user', content: 'user prefers dark mode' }],
      { userId: 'u', infer: false },
    );
  });

  it('rejects empty fact', async () => {
    const result = await run(mockProvider(), { fact: '  ' });
    expect(result.error).toContain('empty');
  });

  it('handles provider error', async () => {
    const provider = mockProvider({
      add: vi.fn().mockRejectedValue(new Error('network')),
    });
    const result = await run(provider, { fact: 'something' });
    expect(result.error).toContain('network');
  });
});

describe('mem0_profile tool', () => {
  async function run(provider: Mem0Provider) {
    const tool = createMem0Tools(provider, 'u').find((t) => t.name === 'mem0_profile')!;
    const result = await tool.execute('c', {});
    return JSON.parse((result.content[0] as { text: string }).text);
  }

  it('returns all memories', async () => {
    const provider = mockProvider({
      getAll: vi.fn().mockResolvedValue([
        { id: '1', memory: 'fact A' },
        { id: '2', memory: 'fact B' },
      ]),
    });
    const result = await run(provider);
    expect(result.count).toBe(2);
    expect(result.result).toContain('fact A');
    expect(result.result).toContain('fact B');
  });

  it('returns message when empty', async () => {
    const result = await run(mockProvider());
    expect(result.result).toBe('No memories stored yet.');
  });
});

// ---------------------------------------------------------------------------
// Key resolver integration
// ---------------------------------------------------------------------------

describe('KeyResolver', () => {
  it('type accepts async provider name resolver', () => {
    const resolver: KeyResolver = async (provider: string) => {
      if (provider === 'openai') return 'sk-test-key';
      return undefined;
    };
    expect(resolver).toBeDefined();
  });
});
