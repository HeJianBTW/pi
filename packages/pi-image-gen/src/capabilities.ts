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

/** Shared pixel-size matcher ("<w>x<h>" or "<w>*<h>") — also used by the DashScope adapter. */
export const SIZE_PIXEL_RE = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i;

/**
 * Truncate a value echoed into a user-facing validation error. Tool params
 * reach these messages even from schema-unaware callers, and an unbounded
 * string would land in the tool result verbatim — same reason image-input
 * never interpolates raw input values.
 */
function truncateEcho(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

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
 * Returns undefined when the contract declares no size semantics at all —
 * schema and validation must stay equally permissive for such models.
 */
export function capabilitySizePattern(caps: ImageModelCapabilities): string | undefined {
  if (hasAspectRatioKnob(caps)) return undefined;
  if (!caps.sizeRange) return undefined;
  const alternatives: string[] = ['[0-9]{2,5}[x*][0-9]{2,5}'];
  const tiers = caps.sizeRange.tiers;
  if (tiers?.length) alternatives.push('[0-9]+(\\.[0-9])?K');
  if (caps.sizeRange.allowAuto) alternatives.push('auto');
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
        `aspectRatio must be one of ${caps.aspectRatios!.join(', ')} for ${modelId} (got "${truncateEcho(params.aspectRatio)}").`,
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
          `imageSize must be one of ${caps.imageSizes.join(', ')} for ${modelId} (got "${truncateEcho(params.imageSize)}").`,
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
        `size must be one of ${caps.sizes.join(', ')} for ${modelId} (got "${truncateEcho(size)}").`,
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
      `size must be ${forms.join(', ')} for ${modelId} (got "${truncateEcho(size)}").`,
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

/**
 * Shape-check a user-supplied capability declaration (customProviders model
 * entry). Invalid fields are dropped with a stderr warning rather than
 * flowing into the tool schema and validators — settings are a trust boundary
 * (CLAUDE.md), and pi-video-gen enforces the same at settings load. Returns a
 * clean Partial; valid fields pass through untouched.
 */
export function sanitizeCapabilities(
  explicit: Partial<ImageModelCapabilities>,
  owner: string,
): Partial<ImageModelCapabilities> {
  const clean: Partial<ImageModelCapabilities> = {};
  const drop = (key: string, value: unknown, rule: string) => {
    console.error(
      `[pi-image-gen] ignoring invalid capabilities.${key} for ${owner}: expected ${rule}, got ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  };
  const stringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue;
    switch (key) {
      case 'nMax':
        if (Number.isInteger(value) && (value as number) >= 1) clean.nMax = value as number;
        else drop(key, value, 'an integer ≥ 1');
        break;
      case 'maxReferenceImages':
        if (Number.isInteger(value) && (value as number) >= 0)
          clean.maxReferenceImages = value as number;
        else drop(key, value, 'an integer ≥ 0');
        break;
      case 'inputMaxBytes':
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
          clean.inputMaxBytes = value;
        else drop(key, value, 'a positive number');
        break;
      case 'inputFormats':
        if (stringArray(value)) clean.inputFormats = value;
        else drop(key, value, 'an array of format labels');
        break;
      case 'sizes':
        if (stringArray(value)) clean.sizes = value;
        else drop(key, value, 'an array of size strings');
        break;
      case 'aspectRatios':
        if (stringArray(value)) clean.aspectRatios = value;
        else drop(key, value, 'an array of aspect ratios');
        break;
      case 'imageSizes':
        if (stringArray(value)) clean.imageSizes = value;
        else drop(key, value, 'an array of size tiers');
        break;
      case 'inputDimAdvice':
        if (typeof value === 'string' && value.length > 0) clean.inputDimAdvice = value;
        else drop(key, value, 'a non-empty string');
        break;
      case 'sizeRange': {
        const range = sanitizeSizeRange(value, key, owner, drop);
        if (range) clean.sizeRange = range;
        break;
      }
      default:
        drop(key, value, 'a known capabilities field');
    }
  }
  return clean;
}

function sanitizeSizeRange(
  value: unknown,
  key: string,
  owner: string,
  drop: (key: string, value: unknown, rule: string) => void,
): ImageModelCapabilities['sizeRange'] | undefined {
  if (typeof value !== 'object' || value === null) {
    drop(key, value, 'a sizeRange object');
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const separator = raw.separator === 'x' || raw.separator === '*' ? raw.separator : undefined;
  const minArea = typeof raw.minArea === 'number' && raw.minArea > 0 ? raw.minArea : undefined;
  const maxArea = typeof raw.maxArea === 'number' && raw.maxArea > 0 ? raw.maxArea : undefined;
  if (!separator || minArea == null || maxArea == null || maxArea <= minArea) {
    console.error(
      `[pi-image-gen] ignoring invalid capabilities.sizeRange for ${owner}: separator must be "x" or "*" and 0 < minArea < maxArea`,
    );
    return undefined;
  }
  const range: NonNullable<ImageModelCapabilities['sizeRange']> = { separator, minArea, maxArea };
  if (typeof raw.minRatio === 'number' || typeof raw.maxRatio === 'number') {
    // The ratio pair is checked like the area pair: an inverted pair would
    // otherwise pass the shape check and make validateSize reject everything.
    if (
      typeof raw.minRatio === 'number' &&
      typeof raw.maxRatio === 'number' &&
      raw.minRatio > 0 &&
      raw.maxRatio > raw.minRatio
    ) {
      range.minRatio = raw.minRatio;
      range.maxRatio = raw.maxRatio;
    } else {
      console.error(
        `[pi-image-gen] ignoring capabilities.sizeRange ratio bounds for ${owner}: expected 0 < minRatio < maxRatio`,
      );
    }
  }
  if (Array.isArray(raw.tiers) && raw.tiers.every((t) => typeof t === 'string' && t.length > 0)) {
    range.tiers = raw.tiers as string[];
  }
  if (raw.allowAuto === true) range.allowAuto = true;
  if (typeof raw.divisibleBy === 'number' && raw.divisibleBy > 0)
    range.divisibleBy = raw.divisibleBy;
  if (typeof raw.maxEdge === 'number' && raw.maxEdge > 0) range.maxEdge = raw.maxEdge;
  return range;
}
