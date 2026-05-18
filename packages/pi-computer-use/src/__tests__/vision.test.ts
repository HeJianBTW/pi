import { describe, expect, test, vi } from 'vitest';
import { createPiVisionCaller, VISUAL_SYSTEM_PROMPT } from '../vision.js';

describe('vision', () => {
  describe('VISUAL_SYSTEM_PROMPT', () => {
    test('contains key instructions for computer-use analysis', () => {
      expect(VISUAL_SYSTEM_PROMPT).toContain('Visual Analysis Agent');
      expect(VISUAL_SYSTEM_PROMPT).toContain('pixel coordinates');
      expect(VISUAL_SYSTEM_PROMPT).toContain('clickable elements');
      expect(VISUAL_SYSTEM_PROMPT).toContain('CENTER point');
      expect(VISUAL_SYSTEM_PROMPT).toContain('Do NOT perform actions');
    });
  });

  describe('createPiVisionCaller()', () => {
    test('throws when model is not found in registry', async () => {
      const mockCtx = {
        modelRegistry: {
          find: vi.fn(() => null),
          getApiKeyAndHeaders: vi.fn(),
        },
      };

      const caller = createPiVisionCaller({ provider: 'openai', model: 'gpt-4o' }, mockCtx as any);

      await expect(caller('describe', 'base64data', 'image/png')).rejects.toThrow(
        'not found in model registry',
      );
    });

    test('throws when auth fails', async () => {
      const mockCtx = {
        modelRegistry: {
          find: vi.fn(() => ({ id: 'gpt-4o', provider: 'openai' })),
          getApiKeyAndHeaders: vi.fn(() => ({ ok: false, error: 'No API key configured' })),
        },
      };

      const caller = createPiVisionCaller({ provider: 'openai', model: 'gpt-4o' }, mockCtx as any);

      await expect(caller('describe', 'base64data', 'image/png')).rejects.toThrow(
        'Auth failed for vision model',
      );
    });
  });
});
