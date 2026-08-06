import { describe, expect, it, vi } from 'vitest';
import {
  capabilitySizeDescription,
  capabilitySizePattern,
  hasImageSizeKnob,
  referenceImageDescription,
  sanitizeCapabilities,
  validateGenerateParams,
} from '../capabilities.js';
import { findBuiltInModel } from '../models.js';
import type { ImageModelCapabilities } from '../types.js';

function capsOf(id: string): ImageModelCapabilities {
  const caps = findBuiltInModel(id)?.capabilities;
  if (!caps) throw new Error(`no capabilities registered for ${id}`);
  return caps;
}

const QWEN3 = capsOf('qwen-image-3.0');
const QWEN2 = capsOf('qwen-image-2.0');
const GPT = capsOf('gpt-image-2');
const SEEDREAM5 = capsOf('doubao-seedream-5-0-260128');
const SEEDREAM5_PRO = capsOf('doubao-seedream-5-0-pro-260628');
const GEMINI_PRO = capsOf('gemini-3-pro-image');
const GEMINI_LITE = capsOf('gemini-3.1-flash-lite-image');
const GEMINI_25 = capsOf('gemini-2.5-flash-image');

function expectInvalid(
  caps: ImageModelCapabilities,
  params: Parameters<typeof validateGenerateParams>[0],
  match: RegExp,
): void {
  expect(() => validateGenerateParams(params, caps, 'model-x')).toThrowError(match);
}

describe('validateGenerateParams — size ranges', () => {
  it('accepts qwen-3.0 sizes inside the area/ratio window, both separators', () => {
    for (const size of ['512*512', '2048*2048', '1536*1024', '2048x2048', '2688*336']) {
      validateGenerateParams({ prompt: 'p', size }, QWEN3, 'qwen-image-3.0');
    }
  });

  it('rejects qwen-3.0 sizes outside the pixel area window', () => {
    expectInvalid(QWEN3, { prompt: 'p', size: '256*256' }, /between 262144 and 4194304/);
    expectInvalid(QWEN3, { prompt: 'p', size: '4096*4096' }, /between 262144 and 4194304/);
  });

  it('rejects qwen-3.0 sizes beyond the 1:8–8:1 aspect cap', () => {
    expectInvalid(QWEN3, { prompt: 'p', size: '2048*128' }, /ratio 16:1 .* between 1:8 and 8:1/);
  });

  it('rejects a tier token for qwen (no tier vocabulary)', () => {
    expectInvalid(QWEN3, { prompt: 'p', size: '1K' }, /size must be/);
  });

  it('qwen-2.0 has no aspect cap (not documented) but keeps the area window', () => {
    validateGenerateParams({ prompt: 'p', size: '2048*128' }, QWEN2, 'qwen-image-2.0');
    validateGenerateParams({ prompt: 'p', size: '1024*1024' }, QWEN2, 'qwen-image-2.0');
    expectInvalid(QWEN2, { prompt: 'p', size: '256*256' }, /between 262144 and 4194304/);
  });

  it('accepts seedream tier tokens only from the model list', () => {
    validateGenerateParams({ prompt: 'p', size: '2K' }, SEEDREAM5, 'seedream-5.0');
    validateGenerateParams({ prompt: 'p', size: '1.5K' }, SEEDREAM5_PRO, 'seedream-5.0-pro');
    expectInvalid(SEEDREAM5, { prompt: 'p', size: '1K' }, /one of 2K, 3K, 4K/);
  });

  it('enforces the seedream 2K pixel floor on explicit sizes', () => {
    validateGenerateParams({ prompt: 'p', size: '2048x2048' }, SEEDREAM5, 'seedream-5.0');
    validateGenerateParams({ prompt: 'p', size: '3750x1250' }, SEEDREAM5, 'seedream-5.0');
    expectInvalid(SEEDREAM5, { prompt: 'p', size: '1024x1024' }, /between 3686400 and 16777216/);
  });

  it('enforces gpt-image-2 rules: auto, divisibility, ratio, longest edge', () => {
    validateGenerateParams({ prompt: 'p', size: 'auto' }, GPT, 'gpt-image-2');
    validateGenerateParams({ prompt: 'p', size: '1536x864' }, GPT, 'gpt-image-2');
    validateGenerateParams({ prompt: 'p', size: '3840x2160' }, GPT, 'gpt-image-2');
    expectInvalid(GPT, { prompt: 'p', size: '1000x1000' }, /divisible by 16/);
    expectInvalid(GPT, { prompt: 'p', size: '3680x1216' }, /ratio/);
    expectInvalid(GPT, { prompt: 'p', size: '3856x2144' }, /longest edge/);
  });

  it('enforces a discrete size list when the model declares one', () => {
    const caps: ImageModelCapabilities = {
      sizes: ['1024x1024', '1792x1024'],
      nMax: 1,
      maxReferenceImages: 0,
      inputFormats: ['PNG'],
      inputMaxBytes: 4 * 1024 * 1024,
    };
    validateGenerateParams({ prompt: 'p', size: '1024x1024' }, caps, 'dall-e-3');
    expectInvalid(caps, { prompt: 'p', size: '2048x2048' }, /one of 1024x1024, 1792x1024/);
  });
});

describe('validateGenerateParams — gemini-style knobs', () => {
  it('rejects size on aspect-ratio models and vice versa', () => {
    expectInvalid(GEMINI_PRO, { prompt: 'p', size: '1024x1024' }, /no pixel-size knob/);
    expectInvalid(QWEN3, { prompt: 'p', aspectRatio: '16:9' }, /does not accept aspectRatio/);
  });

  it('validates aspectRatio against the model vocabulary', () => {
    validateGenerateParams({ prompt: 'p', aspectRatio: '16:9' }, GEMINI_PRO, 'gemini-3-pro-image');
    expectInvalid(GEMINI_PRO, { prompt: 'p', aspectRatio: '9:21' }, /must be one of/);
  });

  it('validates imageSize per model tier list', () => {
    validateGenerateParams({ prompt: 'p', imageSize: '2K' }, GEMINI_PRO, 'gemini-3-pro-image');
    expectInvalid(GEMINI_PRO, { prompt: 'p', imageSize: '3K' }, /must be one of 1K, 2K, 4K/);
    // Lite is fixed at 1K — no other tier passes.
    expectInvalid(GEMINI_LITE, { prompt: 'p', imageSize: '2K' }, /must be one of 1K/);
    // 2.5 has no tier knob at all.
    expectInvalid(GEMINI_25, { prompt: 'p', imageSize: '1K' }, /fixed output resolution/);
  });

  it('exposes imageSize in the schema only when the model has multiple tiers', () => {
    expect(hasImageSizeKnob(GEMINI_PRO)).toBe(true);
    expect(hasImageSizeKnob(GEMINI_LITE)).toBe(false);
    expect(hasImageSizeKnob(GEMINI_25)).toBe(false);
  });
});

describe('validateGenerateParams — n and reference images', () => {
  it('caps n per model and rejects non-integers', () => {
    validateGenerateParams({ prompt: 'p', n: 6 }, QWEN3, 'qwen-image-3.0');
    expectInvalid(QWEN3, { prompt: 'p', n: 7 }, /at most 6/);
    expectInvalid(QWEN3, { prompt: 'p', n: 1.5 }, /positive integer/);
  });

  it('rejects n > 1 for models without a count knob (Seedream)', () => {
    validateGenerateParams({ prompt: 'p', n: 1 }, SEEDREAM5, 'seedream-5.0');
    expectInvalid(SEEDREAM5, { prompt: 'p', n: 2 }, /generates one image per request/);
  });

  it('caps reference-image count per model', () => {
    validateGenerateParams({ prompt: 'p', image: ['a.png', 'b.png', 'c.png'] }, QWEN3, 'q');
    expectInvalid(QWEN3, { prompt: 'p', image: ['a', 'b', 'c', 'd'] }, /at most 3/);
    expectInvalid(GEMINI_25, { prompt: 'p', image: ['a', 'b', 'c', 'd'] }, /at most 3/);
  });
});

describe('capability descriptions', () => {
  it('builds the qwen size description with the asterisk form and ratio cap', () => {
    const text = capabilitySizeDescription(QWEN3);
    expect(text).toContain('<width>*<height>');
    expect(text).toContain('1:8');
    expect(text).toContain('8:1');
  });

  it('builds the seedream size description with tier tokens', () => {
    const text = capabilitySizeDescription(SEEDREAM5);
    expect(text).toContain('2K, 3K, 4K');
    expect(text).toContain('<width>x<height>');
  });

  it('mentions "auto" for gpt-image-2 and nothing for gemini', () => {
    expect(capabilitySizeDescription(GPT)).toContain('"auto"');
    expect(capabilitySizeDescription(GEMINI_PRO)).toBeNull();
  });

  it('describes a discrete size list', () => {
    const caps: ImageModelCapabilities = {
      sizes: ['1024x1024', '1792x1024'],
      nMax: 1,
      maxReferenceImages: 0,
      inputFormats: ['PNG'],
      inputMaxBytes: 4 * 1024 * 1024,
    };
    expect(capabilitySizeDescription(caps)).toContain('1024x1024, 1792x1024');
  });

  it('size patterns accept the canonical and x-form pixel strings plus tokens', () => {
    const qwen = new RegExp(capabilitySizePattern(QWEN3)!);
    expect(qwen.test('2048*2048')).toBe(true);
    expect(qwen.test('2048x2048')).toBe(true);
    expect(qwen.test('2K')).toBe(false);
    const seedream = new RegExp(capabilitySizePattern(SEEDREAM5)!);
    expect(seedream.test('2K')).toBe(true);
    expect(seedream.test('1.5K')).toBe(true);
    expect(seedream.test('2048x2048')).toBe(true);
    const gpt = new RegExp(capabilitySizePattern(GPT)!);
    expect(gpt.test('auto')).toBe(true);
    expect(capabilitySizePattern(GEMINI_PRO)).toBeUndefined();
  });

  it('spells out the reference-image contract', () => {
    const text = referenceImageDescription(QWEN3);
    expect(text).toContain('at most 3');
    expect(text).toContain('JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF');
    expect(text).toContain('10MB');
    expect(text).toContain('384 and 2048');
  });

  it('emits no pattern when the contract declares no size semantics', () => {
    // A merged generic contract (e.g. a custom model declaring only nMax) must
    // keep schema and validation equally permissive — a pattern here would
    // reject free-form sizes that validateSize happily passes.
    const generic: ImageModelCapabilities = {
      nMax: 4,
      maxReferenceImages: 8,
      inputFormats: ['PNG'],
      inputMaxBytes: 20 * 1024 * 1024,
    };
    expect(capabilitySizePattern(generic)).toBeUndefined();
    validateGenerateParams({ prompt: 'p', size: 'large' }, generic, 'custom-x');
  });

  it('bounds values echoed into user-facing validation errors', () => {
    const huge = '9'.repeat(500);
    try {
      validateGenerateParams({ prompt: 'p', size: huge }, QWEN3, 'qwen-image-3.0');
      throw new Error('expected validation to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('…');
      expect(message.length).toBeLessThan(200);
      expect(message).not.toContain(huge);
    }
  });
});

describe('sanitizeCapabilities', () => {
  it('drops malformed fields with a stderr warning and keeps the valid ones', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clean = sanitizeCapabilities(
        {
          nMax: 'six',
          maxReferenceImages: 2,
          inputMaxBytes: 0,
          inputFormats: ['PNG', 7],
          bogusField: true,
        } as unknown as Parameters<typeof sanitizeCapabilities>[0],
        'customProviders.gw model "m"',
      );
      expect(clean).toEqual({ maxReferenceImages: 2 });
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('capabilities.nMax');
      expect(logged).toContain('capabilities.inputMaxBytes');
      expect(logged).toContain('capabilities.inputFormats');
      expect(logged).toContain('capabilities.bogusField');
      expect(logged).toContain('customProviders.gw model "m"');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('validates sizeRange shape and passes a valid one through', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        sanitizeCapabilities({ sizeRange: { separator: 'x', minArea: 100 } } as never, 'test')
          .sizeRange,
      ).toBeUndefined();
      const valid = sanitizeCapabilities(
        {
          sizeRange: {
            separator: '*',
            minArea: 262144,
            maxArea: 4194304,
            minRatio: 0.125,
            maxRatio: 8,
            tiers: ['2K'],
          },
        },
        'test',
      );
      expect(valid.sizeRange?.separator).toBe('*');
      expect(valid.sizeRange?.tiers).toEqual(['2K']);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('drops an inverted ratio pair but keeps the rest of sizeRange', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clean = sanitizeCapabilities(
        {
          sizeRange: {
            separator: 'x',
            minArea: 100,
            maxArea: 200,
            minRatio: 8,
            maxRatio: 0.125,
          },
        },
        'test',
      );
      // The inverted pair would make validateSize reject every size — dropped
      // with a warning while the valid area bounds survive.
      expect(clean.sizeRange?.minArea).toBe(100);
      expect(clean.sizeRange?.minRatio).toBeUndefined();
      expect(clean.sizeRange?.maxRatio).toBeUndefined();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('ratio bounds');
    } finally {
      errSpy.mockRestore();
    }
  });
});
