import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

describe('search', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses search.provider tavily', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'tavily-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: 'test query',
        answer: 'test answer',
        results: [
          { title: 'Result 1', url: 'https://example.com', content: 'content 1', score: 0.9 },
        ],
      }),
    });

    const result = await search({ query: 'test query' }, settings);

    expect(result.provider).toBe('tavily');
    expect(result.query).toBe('test query');
    expect(result.answer).toBe('test answer');
    expect(result.results).toHaveLength(1);

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.tavily.com/search');
    expect(opts.headers.Authorization).toBe('Bearer tavily-key');
  });

  it('uses search.provider kimi with two-round flow', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: '$web_search', arguments: '{"query":"test"}' },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Kimi answer' },
            },
          ],
        }),
      });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('kimi');
    expect(result.answer).toBe('Kimi answer');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses search.provider mimo and extracts annotations', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'mimo' },
      providers: { mimo: { apiKey: 'mimo-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'Mimo answer',
              role: 'assistant',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com',
                  title: 'Example',
                  summary: 'summary',
                },
              ],
            },
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('mimo');
    expect(result.answer).toBe('Mimo answer');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe('https://example.com');
  });

  it('uses search.provider zai', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'zai' },
      providers: { zai: { apiKey: 'zai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'task-1',
        created: 1700000000,
        search_result: [
          { title: 'Z Result', content: 'z content', link: 'https://z.example.com', refer: '1' },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('zai');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe('Z Result');
  });

  it('auto-selects first provider with key when no default set', async () => {
    const settings: WebToolSettings = {
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'auto kimi' },
          },
        ],
      }),
    });

    const result = await search({ query: 'test' }, settings);
    expect(result.provider).toBe('kimi');
  });

  it('throws when no provider configured', async () => {
    await expect(search({ query: 'test' }, {})).rejects.toThrow('No search provider configured');
  });

  it('throws on HTTP error', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(search({ query: 'test' }, settings)).rejects.toThrow('Tavily API error 401');
  });
});
