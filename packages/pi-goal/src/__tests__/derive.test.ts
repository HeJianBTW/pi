import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the LLM layer so derive is tested without a live model / real Agent.
const completeOnce = vi.fn();
vi.mock('../llm.js', () => ({ completeOnce: (...args: unknown[]) => completeOnce(...args) }));

import { deriveCondition } from '../derive.js';
import type { GoalModelRegistry } from '../llm.js';

const registry: GoalModelRegistry = {
  find: () => ({}),
  getApiKeyAndHeaders: async () => ({ ok: true }),
};
const modelConfig = { provider: 'p', model: 'm' };

describe('deriveCondition', () => {
  beforeEach(() => {
    completeOnce.mockReset();
  });

  it('returns a normalized one-line condition', async () => {
    completeOnce.mockResolvedValue('  All unit tests pass and lint is clean  ');
    const result = await deriveCondition({ registry, modelConfig, transcript: 'work' });
    expect(result).toBe('All unit tests pass and lint is clean');
  });

  it('strips wrapping quotes/backticks and takes the first line', () => {
    completeOnce.mockResolvedValue('"The build succeeds"\nextra chatter');
    return deriveCondition({ registry, modelConfig, transcript: 'work' }).then((r) =>
      expect(r).toBe('The build succeeds'),
    );
  });

  it('returns null when the model says NONE', async () => {
    completeOnce.mockResolvedValue('NONE');
    expect(await deriveCondition({ registry, modelConfig, transcript: 'work' })).toBeNull();
  });

  it('returns null when the model call fails', async () => {
    completeOnce.mockResolvedValue(null);
    expect(await deriveCondition({ registry, modelConfig, transcript: 'work' })).toBeNull();
  });

  it('returns null (and skips the model) for an empty transcript', async () => {
    expect(await deriveCondition({ registry, modelConfig, transcript: '   ' })).toBeNull();
    expect(completeOnce).not.toHaveBeenCalled();
  });
});
