import { describe, expect, it } from 'vitest';
import { BUILT_IN_VIDEO_MODELS, findBuiltInModel } from '../providers/models.js';

describe('model registry', () => {
  it('contains only smoke-testable models (no placeholders)', () => {
    expect(BUILT_IN_VIDEO_MODELS.length).toBeGreaterThanOrEqual(8);
    for (const m of BUILT_IN_VIDEO_MODELS) {
      expect(['ark', 'dashscope', 'kling', 'openrouter']).toContain(m.provider);
      expect(
        m.id.startsWith('doubao-seedance-2-0-') ||
          m.id.startsWith('happyhorse-') ||
          m.id.startsWith('kling-') ||
          m.id.startsWith('google/'),
      ).toBe(true);
      expect(m.capabilities.durations[0]).toBeLessThan(m.capabilities.durations[1]);
      expect(m.defaultResolution).toBeOneOf(m.capabilities.resolutions);
      expect(m.defaultAspectRatio).toBeOneOf(m.capabilities.aspectRatios);
    }
  });

  it('veo entry: openrouter provider, audio + flf, 5-8s', () => {
    const veo = findBuiltInModel('veo')!;
    expect(veo.id).toBe('google/veo-3.1');
    expect(veo.provider).toBe('openrouter');
    expect(veo.capabilities.nativeAudio).toBe(true);
    expect(veo.capabilities.supportsFirstLastFrame).toBe(true);
    expect(veo.capabilities.durations).toEqual([5, 8]);
  });

  it('kling entries: turbo silent, omni audio-capable', () => {
    const turbo = findBuiltInModel('kling')!;
    expect(turbo.id).toBe('kling-3.0-turbo');
    expect(turbo.provider).toBe('kling');
    expect(turbo.capabilities.nativeAudio).toBe(false);
    expect(turbo.capabilities.supportsFirstLastFrame).toBe(false);
    const omni = findBuiltInModel('kling-omni')!;
    expect(omni.id).toBe('kling-3.0');
    expect(omni.capabilities.nativeAudio).toBe(true);
    expect(omni.capabilities.supportsFirstLastFrame).toBe(true);
    expect(omni.capabilities.resolutions).toContain('4k');
  });

  it('happyhorse entries: dashscope provider, no audio, no last-frame', () => {
    const hh = findBuiltInModel('happyhorse')!;
    expect(hh.id).toBe('happyhorse-1.1');
    expect(hh.provider).toBe('dashscope');
    expect(hh.capabilities.nativeAudio).toBe(false);
    expect(hh.capabilities.supportsFirstLastFrame).toBe(false);
    expect(hh.capabilities.maxReferenceImages).toBe(9);
  });

  it('resolves the seedance alias to the standard 2.0 model', () => {
    expect(findBuiltInModel('seedance')?.id).toBe('doubao-seedance-2-0-260128');
    expect(findBuiltInModel('seedance-fast')?.id).toBe('doubao-seedance-2-0-fast-260128');
    expect(findBuiltInModel('seedance-mini')?.id).toBe('doubao-seedance-2-0-mini-260615');
  });

  it('fast/mini cap resolution at 720p', () => {
    for (const id of ['seedance-fast', 'seedance-mini']) {
      const caps = findBuiltInModel(id)!.capabilities;
      expect(caps.resolutions).not.toContain('1080p');
    }
  });

  it('returns undefined for unknown ids', () => {
    expect(findBuiltInModel('seedance-2.5')).toBeUndefined();
    expect(findBuiltInModel('')).toBeUndefined();
  });
});
