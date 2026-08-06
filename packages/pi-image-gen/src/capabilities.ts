import { ImageGenError } from './errors.js';
import type { GenerateImageParams, ImageModelCapabilities } from './types.js';

/**
 * Capability-driven description and validation helpers, shared by the tool
 * schema builder (index.ts) and the generate path (generate.ts). The schema
 * is the first line of defense (the LLM sees exact enums/patterns); the
 * validators here are the deterministic second line for direct API callers
 * and schema-unaware routes. All user-facing messages list the legal values
 * so a retry succeeds on the first attempt — same style as pi-video-gen.
 */

const SIZE_PIXEL_RE = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i;

/** True when the model uses aspectRatio/imageSize instead of a pixel size. */
export function hasAspectRatioKnob(caps: ImageModelCapabilities): boolean {
  return Boolean(caps.aspectRatios?.length);
}

/** True when the schema should expose an `imageSize` enum for this model. */
export function hasImageSizeKnob(caps: ImageModelCapabilities): boolean {
  return hasAspectRatioKnob(caps) && (caps.imageSizes?.length ?? 0) > 1;
}

/** Human-readable ratio bound: 1/8 → "1:8", 3 → "3:1", 2.5 → "2.5:1". */
function formatRatio(value: number): string {
  if (value < 1) {
    const inverse = 1 / value;
    return `1:${Number.isInteger(inverse) ? inverse : inverse.toFixed(1)}`;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)}:1`;
}

/**
 * `size` parameter description for a capability-bearing model. Returns null
 * when the model has no pixel-size knob (Gemini aspect-ratio models) — the
 * schema must hide the param entirely in that case.
 */
export function capabilitySizeDescription(caps: ImageModelCapabilities): string | null {
  if (hasAspectRatioKnob(caps)) return null;
  if (caps.sizes) {
    return `Image size. One of: ${caps.sizes.join(', ')}. Omit to use the model default.`;
  }
  const range = caps.sizeRange;
  if (!range) return null;
  const example = range.separator === '*' ? '2048*2048' : '2048x2048';
  const parts = [
    `Image size as "<width>${range.separator}<height>" (e.g. "${example}"). Total pixels must be between ${range.minArea} and ${range.maxArea}`,
  ];
  if (range.minRatio != null && range.maxRatio != null) {
    parts.push(
      `width/height ratio between ${formatRatio(range.minRatio)} and ${formatRatio(range.maxRatio)}`,
    );
  }
  if (range.divisibleBy) parts.push(`both dimensions divisible by ${range.divisibleBy}`);
  if (range.maxEdge) parts.push(`longest edge at most ${range.maxEdge}px`);
  let text = `${parts.join('; ')}.`;
  if (range.tiers) {
    text += ` Alternatively a tier token: ${range.tiers.join(', ')} — do not mix the two forms.`;
  }
  if (range.allowAuto) text += ' "auto" lets the model pick.';
  text += ' Omit to use the model default.';
  return text;
}

/**
 * JSON-schema pattern for the `size` string, permissive on purpose: the pixel
 * form accepts both separators (the DashScope adapter normalizes x → *), and
 * tier/auto tokens come from the capability contract. Semantic bounds (area,
 * ratio, …) are enforced by {@link validateGenerateParams}, not the pattern.
 */
export function capabilitySizePattern(caps: ImageModelCapabilities): string | undefined {
  if (hasAspectRatioKnob(caps)) return undefined;
  const alternatives: string[] = ['[0-9]{2,5}[x*][0-9]{2,5}'];
  const tiers = caps.sizeRange?.tiers;
  if (tiers?.length) alternatives.push('[0-9]+(\\.[0-9])?K');
  if (caps.sizeRange?.allowAuto) alternatives.push('auto');
  return `^(${alternatives.join('|')})$`;
}

/**
 * Suffix for the `image` parameter description spelling out the active
 * model's reference-image contract (formats, count, byte ceiling, advisory).
 */
export function referenceImageDescription(caps: ImageModelCapabilities): string {
  const mb = Math.round(caps.inputMaxBytes / (1024 * 1024));
  let text = `The active model accepts at most ${caps.maxReferenceImages} reference image(s) — formats: ${caps.inputFormats.join('/')}; each at most ${mb}MB.`;
  if (caps.inputDimAdvice) text += ` ${caps.inputDimAdvice}.`;
  return text;
}

/**
 * Pre-flight validation against the model's capability contract. Throws
 * ImageGenError with an actionable, legal-values listing message; called
 * before any reference image is downloaded or any paid request is made.
 */
export function validateGenerateParams(
  params: GenerateImageParams,
  caps: ImageModelCapabilities,
  modelId: string,
): void {
  if (params.n != null) {
    if (!Number.isInteger(params.n) || params.n < 1) {
      throw new ImageGenError(`n must be a positive integer (got ${params.n}).`, 'n invalid');
    }
    if (caps.nMax === 1 && params.n > 1) {
      throw new ImageGenError(
        `${modelId} generates one image per request — remove n (got ${params.n}).`,
        'n unsupported by model',
      );
    }
    if (params.n > caps.nMax) {
      throw new ImageGenError(
        `n must be at most ${caps.nMax} for ${modelId} (got ${params.n}).`,
        'n out of range',
      );
    }
  }

  const refCount = params.image?.length ?? 0;
  if (refCount > caps.maxReferenceImages) {
    throw new ImageGenError(
      `Too many reference images (${refCount}) — ${modelId} accepts at most ${caps.maxReferenceImages}.`,
      'too many reference images',
    );
  }

  if (hasAspectRatioKnob(caps)) {
    if (params.size) {
      throw new ImageGenError(
        `${modelId} has no pixel-size knob — pass aspectRatio${hasImageSizeKnob(caps) ? ' (and optionally imageSize)' : ''} instead of size.`,
        'size unsupported by model',
      );
    }
    if (params.aspectRatio && !caps.aspectRatios!.includes(params.aspectRatio)) {
      throw new ImageGenError(
        `aspectRatio must be one of ${caps.aspectRatios!.join(', ')} for ${modelId} (got "${params.aspectRatio}").`,
        'aspectRatio not allowed',
      );
    }
    if (params.imageSize) {
      if (!caps.imageSizes?.length) {
        throw new ImageGenError(
          `${modelId} has a fixed output resolution — remove imageSize.`,
          'imageSize unsupported by model',
        );
      }
      if (!caps.imageSizes.includes(params.imageSize)) {
        throw new ImageGenError(
          `imageSize must be one of ${caps.imageSizes.join(', ')} for ${modelId} (got "${params.imageSize}").`,
          'imageSize not allowed',
        );
      }
    }
    return;
  }

  if (params.aspectRatio || params.imageSize) {
    throw new ImageGenError(
      `${modelId} does not accept aspectRatio/imageSize — use size ("<width>${caps.sizeRange?.separator ?? 'x'}<height>") instead.`,
      'aspect knobs unsupported by model',
    );
  }
  if (params.size) validateSize(params.size, caps, modelId);
}

function validateSize(size: string, caps: ImageModelCapabilities, modelId: string): void {
  const trimmed = size.trim();
  if (caps.sizes) {
    if (!caps.sizes.includes(trimmed)) {
      throw new ImageGenError(
        `size must be one of ${caps.sizes.join(', ')} for ${modelId} (got "${size}").`,
        'size not allowed',
      );
    }
    return;
  }
  const range = caps.sizeRange;
  if (!range) return; // no size contract — pass through to the provider
  if (range.allowAuto && trimmed === 'auto') return;
  if (range.tiers?.includes(trimmed)) return;

  const match = SIZE_PIXEL_RE.exec(trimmed);
  if (!match) {
    const forms = [`"<width>${range.separator}<height>"`];
    if (range.tiers) forms.push(`one of ${range.tiers.join(', ')}`);
    if (range.allowAuto) forms.push('"auto"');
    throw new ImageGenError(
      `size must be ${forms.join(', ')} for ${modelId} (got "${size}").`,
      'size malformed',
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const area = width * height;
  if (area < range.minArea || area > range.maxArea) {
    throw new ImageGenError(
      `size ${width}x${height} is ${area} px in total — ${modelId} requires between ${range.minArea} and ${range.maxArea} px.`,
      'size area out of range',
    );
  }
  if (range.minRatio != null && range.maxRatio != null) {
    const ratio = width / height;
    if (ratio < range.minRatio || ratio > range.maxRatio) {
      throw new ImageGenError(
        `size ${width}x${height} has ratio ${formatRatio(ratio)} — ${modelId} allows between ${formatRatio(range.minRatio)} and ${formatRatio(range.maxRatio)}.`,
        'size ratio out of range',
      );
    }
  }
  if (range.divisibleBy && (width % range.divisibleBy !== 0 || height % range.divisibleBy !== 0)) {
    throw new ImageGenError(
      `size ${width}x${height} — ${modelId} requires both dimensions divisible by ${range.divisibleBy}.`,
      'size not divisible',
    );
  }
  if (range.maxEdge && Math.max(width, height) > range.maxEdge) {
    throw new ImageGenError(
      `size ${width}x${height} — ${modelId} caps the longest edge at ${range.maxEdge}px.`,
      'size edge too long',
    );
  }
}
