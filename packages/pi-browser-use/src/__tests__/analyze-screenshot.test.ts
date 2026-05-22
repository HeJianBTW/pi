import { describe, expect, test, vi } from 'vitest';
import {
  createFetchVisionCaller,
  handleAnalyzeScreenshot,
  type VisionCaller,
} from '../analyze-screenshot.js';

vi.mock('@earendil-works/pi-coding-agent', () => {
  const mockModel = { id: 'gpt-4o', provider: 'openai' };
  const mockRegistry = {
    find: vi.fn((provider: string, model: string) => {
      if (provider === 'openai' && model === 'gpt-4o') return mockModel;
      return undefined;
    }),
    getApiKeyAndHeaders: vi.fn(() =>
      Promise.resolve({ ok: true, apiKey: 'resolved-key', headers: {} }),
    ),
  };
  const mockAuthStorage = {};
  return {
    AuthStorage: { create: () => mockAuthStorage },
    ModelRegistry: { create: () => mockRegistry },
    __mockRegistry: mockRegistry,
  };
});

vi.mock('@earendil-works/pi-ai', () => ({
  complete: vi.fn(() =>
    Promise.resolve({
      content: [{ type: 'text', text: 'Analysis result' }],
    }),
  ),
}));

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
  test('resolves model from registry and calls complete()', async () => {
    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    const result = await caller('Find button', 'aW1hZ2VkYXRh', 'image/png');

    expect(result).toBe('Analysis result');

    const { complete } = await import('@earendil-works/pi-ai');
    expect(complete).toHaveBeenCalled();
  });

  test('throws when model not found in registry', async () => {
    const caller = createFetchVisionCaller({ provider: 'unknown', model: 'no-model' });
    await expect(caller('test', 'data', 'image/png')).rejects.toThrow(
      'not found in model registry',
    );
  });

  test('throws when auth fails', async () => {
    const { __mockRegistry } = (await import('@earendil-works/pi-coding-agent')) as any;
    __mockRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: 'no key configured',
    });

    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await expect(caller('test', 'data', 'image/png')).rejects.toThrow('Auth failed');
  });

  test('passes image data and mimeType to complete()', async () => {
    const piAi = await import('@earendil-works/pi-ai');
    (piAi.complete as any).mockClear();

    const caller = createFetchVisionCaller({ provider: 'openai', model: 'gpt-4o' });
    await caller('Describe this', 'aW1hZ2U=', 'image/jpeg');

    const callArgs = (piAi.complete as any).mock.calls[0];
    const messages = callArgs[1].messages;
    const imageContent = messages[0].content[1];
    expect(imageContent.type).toBe('image');
    expect(imageContent.data).toBe('aW1hZ2U=');
    expect(imageContent.mimeType).toBe('image/jpeg');
  });
});
