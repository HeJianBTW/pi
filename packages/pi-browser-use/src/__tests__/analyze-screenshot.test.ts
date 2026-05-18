import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createFetchVisionCaller,
  handleAnalyzeScreenshot,
  type VisionCaller,
} from '../analyze-screenshot.js';
import type { VisionModelConfig } from '../config.js';

const visionConfig: VisionModelConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
};

function createMockClient(screenshotContent?: any[]) {
  return {
    callTool: vi.fn((_name: string, _args: Record<string, unknown>) =>
      Promise.resolve({
        content: screenshotContent ?? [
          { type: 'image', data: 'aW1hZ2VkYXRh', mimeType: 'image/png' },
        ],
      }),
    ),
    connect: vi.fn(() => Promise.resolve()),
    listAllTools: vi.fn(() => Promise.resolve([])),
    close: vi.fn(() => Promise.resolve()),
  } as any;
}

/** Mock VisionCaller that returns a fixed analysis string. */
function mockVisionCaller(response: string): VisionCaller {
  return vi.fn(() => Promise.resolve(response));
}

/** Mock VisionCaller that throws an error. */
function failingVisionCaller(error: string): VisionCaller {
  return vi.fn(() => Promise.reject(new Error(error)));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('handleAnalyzeScreenshot', () => {
  test('successful flow returns analysis', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Blue button at (150, 300)');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find the blue button',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Blue button at (150, 300)');
    expect(client.callTool).toHaveBeenCalledWith('take_screenshot', {});
    expect(caller).toHaveBeenCalledWith('Find the blue button', 'aW1hZ2VkYXRh', 'image/png');
  });

  test('no screenshot data returns error', async () => {
    const client = createMockClient([{ type: 'text', text: 'No image' }]);
    const caller = mockVisionCaller('should not be called');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to capture screenshot');
    expect(caller).not.toHaveBeenCalled();
  });

  test('empty screenshot content returns error', async () => {
    const client = createMockClient([]);
    const caller = mockVisionCaller('should not be called');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to capture screenshot');
    expect(caller).not.toHaveBeenCalled();
  });

  test('vision model 404 returns model-not-available', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('Vision model API error (404): Not Found');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available');
  });

  test('vision model generic error returns error message', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('Vision model API error (500): Internal Server Error');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Visual analysis failed');
  });

  test('empty analysis returns error', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no analysis');
  });

  test('defaults instruction to empty string', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Full page analysis');
    const result = await handleAnalyzeScreenshot(client, caller, {});

    expect(result.isError).toBeUndefined();
    expect(caller).toHaveBeenCalledWith('', 'aW1hZ2VkYXRh', 'image/png');
  });

  test('uses correct mimeType from screenshot response', async () => {
    const client = createMockClient([{ type: 'image', data: 'jpegdata', mimeType: 'image/jpeg' }]);
    const caller = mockVisionCaller('result');
    await handleAnalyzeScreenshot(client, caller, { instruction: 'test' });

    expect(caller).toHaveBeenCalledWith('test', 'jpegdata', 'image/jpeg');
  });

  test('permission error returns model-not-available', async () => {
    const client = createMockClient();
    const caller = failingVisionCaller('permission denied: insufficient scope');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find button',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not available');
  });

  test('prefixes success result with Visual Analysis Result', async () => {
    const client = createMockClient();
    const caller = mockVisionCaller('Found button at (100, 200)');
    const result = await handleAnalyzeScreenshot(client, caller, {
      instruction: 'Find the button',
    });

    expect(result.content[0].text).toMatch(/^Visual Analysis Result:/);
    expect(result.content[0].text).toContain('Found button at (100, 200)');
  });
});

describe('createFetchVisionCaller', () => {
  test('calls fetch with correct URL, headers, and body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Analysis result' } }],
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as any;

    const caller = createFetchVisionCaller(visionConfig);
    const result = await caller('Find button', 'aW1hZ2VkYXRh', 'image/png');

    expect(result).toBe('Analysis result');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-key' }));
  });

  test('throws on missing API key', async () => {
    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await expect(caller('Find button', 'aW1hZ2VkYXRh', 'image/png')).rejects.toThrow('No API key');
  });

  test('throws on non-OK response', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('Not Found', { status: 404 })),
    ) as any;

    const caller = createFetchVisionCaller(visionConfig);
    await expect(caller('Find button', 'aW1hZ2VkYXRh', 'image/png')).rejects.toThrow(
      'Vision model API error (404)',
    );
  });

  test('uses custom baseUrl when provided', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchMock as any;

    const caller = createFetchVisionCaller({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'key',
      baseUrl: 'https://custom.proxy.com/v1',
    });
    await caller('test', 'data', 'image/png');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://custom.proxy.com/v1/chat/completions');
  });

  test('reads API key from env when not in config', async () => {
    const originalEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-key';

    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchMock as any;

    try {
      const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
      await caller('test', 'data', 'image/png');

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer env-key');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    }
  });

  test('returns empty string when API returns no content', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    ) as any;

    const caller = createFetchVisionCaller(visionConfig);
    const result = await caller('Find button', 'data', 'image/png');
    expect(result).toBe('');
  });

  test('sends image as data URI in request body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
      ),
    );
    globalThis.fetch = fetchMock as any;

    const caller = createFetchVisionCaller(visionConfig);
    await caller('test', 'aW1hZ2U=', 'image/jpeg');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    const imageContent = body.messages[1].content[1];
    expect(imageContent.image_url.url).toBe('data:image/jpeg;base64,aW1hZ2U=');
  });
});
