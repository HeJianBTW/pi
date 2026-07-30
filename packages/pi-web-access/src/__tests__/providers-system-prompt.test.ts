import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnvironmentContext, SEARCH_SYSTEM_PROMPT } from '../providers/base.js';
import { search } from '../search.js';
import type { WebToolSettings } from '../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SEARCH_SYSTEM_PROMPT and getEnvironmentContext', () => {
  it('SEARCH_SYSTEM_PROMPT matches Claude Code style', () => {
    expect(SEARCH_SYSTEM_PROMPT).toBe('You are an assistant for performing a web search tool use');
  });

  it('getEnvironmentContext returns date and timezone', () => {
    const ctx = getEnvironmentContext();
    expect(ctx).toMatch(/^\[Current date: \d{4}-\d{2}-\d{2}, Timezone: .+\]$/);
  });
});

describe('LLM providers include system prompt and environment context', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('kimi: sends system prompt and env context in user message', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'kimi' },
      providers: { kimi: { apiKey: 'kimi-key' } },
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tools: [
            {
              type: 'function',
              function: {
                name: 'web_search',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }],
        }),
      });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[1]![1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('[Current date:');
    expect(body.messages[1].content).toContain('test query');
  });

  it('mimo: sends system prompt and env context in user message', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'mimo' },
      providers: { mimo: { apiKey: 'mimo-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'answer', annotations: [] } }],
      }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('[Current date:');
    expect(body.messages[1].content).toContain('test query');
  });

  it('gemini: sends systemInstruction and env context in content', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'gemini' },
      providers: { gemini: { apiKey: 'gemini-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'answer' }], role: 'model' } }],
      }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.systemInstruction.parts[0].text).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.contents[0].parts[0].text).toContain('[Current date:');
    expect(body.contents[0].parts[0].text).toContain('test query');
  });

  it('openai: sends instructions and env context in input', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openai' },
      providers: { openai: { apiKey: 'oai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
      }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.instructions).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.input).toContain('[Current date:');
    expect(body.input).toContain('test query');
  });

  it('xai: sends system message and env context in input array', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'xai' },
      providers: { xai: { apiKey: 'xai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output: [], citations: [] }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.input[0].role).toBe('system');
    expect(body.input[0].content).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.input[1].role).toBe('user');
    expect(body.input[1].content).toContain('[Current date:');
    expect(body.input[1].content).toContain('test query');
  });

  it('anthropic: sends system field and env context in user message', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'anthropic' },
      providers: { anthropic: { apiKey: 'ant-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'answer' }] }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.system).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('[Current date:');
    expect(body.messages[0].content).toContain('test query');
  });

  it('openrouter: sends system message and env context in user message', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'openrouter' },
      providers: { openrouter: { apiKey: 'or-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('[Current date:');
    expect(body.messages[1].content).toContain('test query');
  });

  it('perplexity: sends instructions and env context in input', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'perplexity' },
      providers: { perplexity: { apiKey: 'pplx-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
      }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.instructions).toBe(SEARCH_SYSTEM_PROMPT);
    expect(body.input).toContain('[Current date:');
    expect(body.input).toContain('test query');
  });
});

describe('Pure API providers do NOT include system prompt', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('tavily: no system prompt or env context in body', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'tavily' },
      providers: { tavily: { apiKey: 'tv-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ query: 'test', answer: 'answer', results: [] }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.system).toBeUndefined();
    expect(body.messages).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.query).toBe('test query');
  });

  it('zai: no system prompt or env context in body', async () => {
    const settings: WebToolSettings = {
      search: { provider: 'zai' },
      providers: { zai: { apiKey: 'zai-key' } },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ search_result: [] }),
    });

    await search({ query: 'test query' }, settings);

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.system).toBeUndefined();
    expect(body.messages).toBeUndefined();
    expect(body.instructions).toBeUndefined();
    expect(body.search_query).toBe('test query');
  });
});
