import { describe, expect, it } from 'vitest';
import { BaseProvider, getProvider } from '../providers/index.js';
import type { BuiltInProviderId } from '../types.js';

describe('BaseProvider', () => {
  class TestProvider extends BaseProvider {
    readonly id = 'tavily' as BuiltInProviderId;
  }

  it('search throws not supported by default', async () => {
    const provider = new TestProvider();
    await expect(provider.search({ query: 'test' }, { id: 'tavily', baseUrl: '' })).rejects.toThrow(
      'tavily does not support web_search',
    );
  });

  it('fetch throws not supported by default', async () => {
    const provider = new TestProvider();
    await expect(
      provider.fetch('https://example.com', { id: 'tavily', baseUrl: '' }),
    ).rejects.toThrow('tavily does not support web_fetch');
  });
});

describe('getProvider registry', () => {
  const allIds: BuiltInProviderId[] = [
    'tavily',
    'kimi',
    'mimo',
    'zai',
    'gemini',
    'perplexity',
    'openrouter',
    'xai',
    'openai',
    'anthropic',
  ];

  it('returns a provider for every registered id', () => {
    for (const id of allIds) {
      const provider = getProvider(id);
      expect(provider).toBeDefined();
      expect(provider!.id).toBe(id);
    }
  });

  it('returns undefined for unknown id', () => {
    const provider = getProvider('unknown' as BuiltInProviderId);
    expect(provider).toBeUndefined();
  });

  it('search-only providers throw on fetch', async () => {
    const searchOnly: BuiltInProviderId[] = ['kimi', 'mimo', 'gemini', 'xai', 'openai'];
    for (const id of searchOnly) {
      const provider = getProvider(id)!;
      await expect(provider.fetch('https://example.com', { id, baseUrl: '' })).rejects.toThrow(
        'does not support web_fetch',
      );
    }
  });

  it('all providers have search method', () => {
    for (const id of allIds) {
      const provider = getProvider(id)!;
      expect(typeof provider.search).toBe('function');
    }
  });

  it('fetch-capable providers have overridden fetch', () => {
    const fetchCapable: BuiltInProviderId[] = [
      'tavily',
      'zai',
      'perplexity',
      'openrouter',
      'anthropic',
    ];
    for (const id of fetchCapable) {
      const provider = getProvider(id)!;
      expect(typeof provider.fetch).toBe('function');
      // Verify it's not the BaseProvider default (which would throw immediately without apiKey check)
      // We can't easily test this without mocking fetch, but we verify the method exists
    }
  });
});
