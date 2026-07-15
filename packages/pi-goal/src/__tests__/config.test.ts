import { describe, expect, it } from 'vitest';
import { DEFAULTS, resolveConfig } from '../config.js';

describe('resolveConfig', () => {
  it('applies defaults when nothing is provided', () => {
    const config = resolveConfig();
    expect(config.maxIterations).toBe(DEFAULTS.maxIterations);
    expect(config.transcriptMaxChars).toBe(DEFAULTS.transcriptMaxChars);
    expect(config.requireConfirmForDerived).toBe(true);
    expect(config.model).toBeUndefined();
    expect(config.tokenBudget).toBeUndefined();
  });

  it('accepts a valid model', () => {
    const config = resolveConfig({ model: { provider: 'anthropic', model: 'haiku' } });
    expect(config.model).toEqual({ provider: 'anthropic', model: 'haiku' });
  });

  it('drops an invalid/partial model (degrades to disabled engine)', () => {
    expect(resolveConfig({ model: { provider: '', model: 'x' } }).model).toBeUndefined();
    expect(resolveConfig({ model: { provider: 'p' } as never }).model).toBeUndefined();
  });

  it('sanitizes positive integers and ignores non-positive values', () => {
    expect(resolveConfig({ maxIterations: 3.9 }).maxIterations).toBe(3);
    expect(resolveConfig({ maxIterations: 0 }).maxIterations).toBe(DEFAULTS.maxIterations);
    expect(resolveConfig({ maxIterations: -5 }).maxIterations).toBe(DEFAULTS.maxIterations);
    expect(resolveConfig({ transcriptMaxChars: 100 }).transcriptMaxChars).toBe(100);
  });

  it('keeps a positive tokenBudget and drops invalid ones', () => {
    expect(resolveConfig({ tokenBudget: 5000 }).tokenBudget).toBe(5000);
    expect(resolveConfig({ tokenBudget: 0 }).tokenBudget).toBeUndefined();
    expect(resolveConfig({ tokenBudget: -1 }).tokenBudget).toBeUndefined();
  });

  it('honors requireConfirmForDerived override', () => {
    expect(resolveConfig({ requireConfirmForDerived: false }).requireConfirmForDerived).toBe(false);
  });
});
