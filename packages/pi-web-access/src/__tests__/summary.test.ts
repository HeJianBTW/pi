import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  complete: vi.fn(),
}));

import { complete } from '@earendil-works/pi-ai/compat';
import { summarizeContent } from '../summary.js';
import type { SummaryModelConfig } from '../types.js';

const mockComplete = vi.mocked(complete);

describe('summarizeContent', () => {
  const config: SummaryModelConfig = { provider: 'openai', model: 'gpt-4o-mini' };

  const mockCtx = {
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(),
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls complete with content and prompt, returns text', async () => {
    const mockModel = { id: 'gpt-4o-mini', provider: 'openai' };
    mockCtx.modelRegistry.find.mockReturnValue(mockModel);
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'key' });
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'Summarized content here' }],
    } as any);

    const result = await summarizeContent(
      '# Full page\nLots of content...',
      'What is this page about?',
      config,
      mockCtx,
    );

    expect(result).toBe('Summarized content here');
    expect(mockCtx.modelRegistry.find).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(mockComplete).toHaveBeenCalledOnce();

    const [model, messages, options] = mockComplete.mock.calls[0]!;
    expect(model).toBe(mockModel);
    expect(options!.apiKey).toBe('key');
    expect(options!.temperature).toBe(0);

    const userContent = (messages as any).messages[0].content[0].text;
    expect(userContent).toContain('Full page');
    expect(userContent).toContain('What is this page about?');
  });

  it('truncates content exceeding 100k chars', async () => {
    const mockModel = { id: 'model' };
    mockCtx.modelRegistry.find.mockReturnValue(mockModel);
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'k' });
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    } as any);

    const longContent = 'x'.repeat(150_000);
    await summarizeContent(longContent, 'summarize', config, mockCtx);

    const userText = (mockComplete.mock.calls[0]![1] as any).messages[0].content[0].text;
    expect(userText).toContain('[Content truncated due to length...]');
    expect(userText.length).toBeLessThan(150_000);
  });

  it('throws when model not found in registry', async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);

    await expect(summarizeContent('content', 'prompt', config, mockCtx)).rejects.toThrow(
      'not found in model registry',
    );
  });

  it('throws when auth fails', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: 'no key' });

    await expect(summarizeContent('content', 'prompt', config, mockCtx)).rejects.toThrow(
      'Auth failed',
    );
  });

  it('passes headers from auth to complete options', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: 'k',
      headers: { 'X-Custom': 'val' },
    });
    mockComplete.mockResolvedValue({ content: [{ type: 'text', text: 'r' }] } as any);

    await summarizeContent('c', 'p', config, mockCtx);

    const options = mockComplete.mock.calls[0]![2];
    expect(options!.headers).toEqual({ 'X-Custom': 'val' });
  });

  it('joins multiple text blocks from response', async () => {
    mockCtx.modelRegistry.find.mockReturnValue({ id: 'model' });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: 'k' });
    mockComplete.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: ' Part 2' },
      ],
    } as any);

    const result = await summarizeContent('c', 'p', config, mockCtx);
    expect(result).toBe('Part 1 Part 2');
  });
});
