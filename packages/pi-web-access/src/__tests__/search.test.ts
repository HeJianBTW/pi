import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

const KIMI_FORMULA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

function kimiToolCalls(
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>,
  message: Record<string, unknown> = {},
) {
  return okJson({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', ...message, tool_calls: toolCalls },
      },
    ],
  });
}

function kimiAnswer(content: string) {
  return okJson({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  });
}

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

  it('uses search.provider kimi through the Formula web search tool', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }))
      .mockResolvedValueOnce(
        kimiToolCalls([
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"test"}' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        okJson({
          status: 'succeeded',
          context: { output: '', encrypted_output: 'encrypted search result' },
        }),
      )
      .mockResolvedValueOnce(kimiAnswer('Kimi answer'));

    const result = await search({ query: 'test' }, settings);

    expect(result.provider).toBe('kimi');
    expect(result.answer).toBe('Kimi answer');
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.moonshot.cn/v1/formulas/moonshot/web-search:latest/tools',
      'https://api.moonshot.cn/v1/chat/completions',
      'https://api.moonshot.cn/v1/formulas/moonshot/web-search:latest/fibers',
      'https://api.moonshot.cn/v1/chat/completions',
    ]);

    const firstChatBody = JSON.parse(mockFetch.mock.calls[1]![1].body);
    expect(firstChatBody.model).toBe('kimi-k3');
    expect(firstChatBody.tools).toEqual(KIMI_FORMULA_TOOLS);
    expect(firstChatBody).not.toHaveProperty('thinking');

    const fiberBody = JSON.parse(mockFetch.mock.calls[2]![1].body);
    expect(fiberBody).toEqual({ name: 'web_search', arguments: '{"query":"test"}' });

    const finalChatBody = JSON.parse(mockFetch.mock.calls[3]![1].body);
    expect(finalChatBody.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'encrypted search result',
    });
  });

  it('handles every Formula tool call across multiple rounds', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }))
      .mockResolvedValueOnce(
        kimiToolCalls(
          [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"one"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"two"}' },
            },
          ],
          { content: '', reasoning_content: 'search twice' },
        ),
      )
      .mockResolvedValueOnce(okJson({ status: 'succeeded', context: { output: 'result one' } }))
      .mockResolvedValueOnce(
        okJson({
          status: 'succeeded',
          context: { encrypted_output: 'result two' },
        }),
      )
      .mockResolvedValueOnce(
        kimiToolCalls([
          {
            id: 'call_3',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"three"}' },
          },
        ]),
      )
      .mockResolvedValueOnce(okJson({ status: 'succeeded', context: { output: 'result three' } }))
      .mockResolvedValueOnce(kimiAnswer('Combined answer'));

    const result = await search({ query: 'test' }, settings);

    expect(result.answer).toBe('Combined answer');
    const secondChatBody = JSON.parse(mockFetch.mock.calls[4]![1].body);
    expect(secondChatBody.messages.slice(-3)).toEqual([
      expect.objectContaining({ role: 'assistant', reasoning_content: 'search twice' }),
      { role: 'tool', tool_call_id: 'call_1', content: 'result one' },
      { role: 'tool', tool_call_id: 'call_2', content: 'result two' },
    ]);
  });

  it('rejects an unsuccessful Formula web search', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }))
      .mockResolvedValueOnce(
        kimiToolCalls([
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"test"}' },
          },
        ]),
      )
      .mockResolvedValueOnce(okJson({ status: 'failed', context: { error: 'internal details' } }));

    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Kimi Formula web search failed',
    );
  });

  it('rejects an empty Formula tool declaration', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch.mockResolvedValueOnce(okJson({ tools: [] }));

    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Kimi Formula web search returned no tools',
    );
  });

  it('rejects a successful Formula web search without output', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }))
      .mockResolvedValueOnce(
        kimiToolCalls([
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"test"}' },
          },
        ]),
      )
      .mockResolvedValueOnce(okJson({ status: 'succeeded', context: {} }));

    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Kimi Formula web search returned no output',
    );
  });

  it('stops after eight Formula tool rounds', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch.mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }));
    for (let round = 0; round < 8; round++) {
      mockFetch
        .mockResolvedValueOnce(
          kimiToolCalls([
            {
              id: `call_${round}`,
              type: 'function',
              function: { name: 'web_search', arguments: '{"query":"test"}' },
            },
          ]),
        )
        .mockResolvedValueOnce(okJson({ status: 'succeeded', context: { output: 'result' } }));
    }

    await expect(search({ query: 'test' }, settings)).rejects.toThrow(
      'Kimi Formula web search exceeded 8 tool rounds',
    );
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

  it('uses search.provider deepseek with Responses API web search', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'deepseek' },
      providers: { deepseek: { apiKey: 'deepseek-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'DeepSeek answer',
                annotations: [
                  { type: 'url_citation', url: 'https://example.com', title: 'Example' },
                ],
              },
            ],
          },
        ],
      }),
    });

    const result = await search({ query: 'test query' }, settings);

    expect(result).toEqual({
      provider: 'deepseek',
      query: 'test query',
      answer: 'DeepSeek answer',
      results: [{ title: 'Example', url: 'https://example.com', content: '' }],
    });
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/responses');
    expect(options.headers.Authorization).toBe('Bearer deepseek-key');
    expect(JSON.parse(options.body)).toEqual(
      expect.objectContaining({
        model: 'deepseek-v4-flash',
        tools: [{ type: 'web_search' }],
      }),
    );
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
    mockFetch
      .mockResolvedValueOnce(okJson({ tools: KIMI_FORMULA_TOOLS }))
      .mockResolvedValueOnce(kimiAnswer('auto kimi'));

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
