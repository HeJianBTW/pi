import { lstat } from 'node:fs/promises';
import { safeBasename, VideoGenError } from './errors.js';
import { assertSafeId } from './jobs/store.js';

/**
 * TimelineSpec (C1+): agent-authored promo/explainer video from still images,
 * text overlays, TTS narration, and motion — rendered LOCALLY, no video model.
 *
 * File: `<jobDir>/timeline-input.json`; parent dir is the job (same identity
 * rules as compose/render jobs).
 */

export const MOTIONS = [
  'static',
  'kenburns-in',
  'kenburns-out',
  'pan-left',
  'pan-right',
  'zoom-in',
  'zoom-out',
] as const;
export type Motion = (typeof MOTIONS)[number];

export const OVERLAY_POSITIONS = ['bottom-left', 'bottom-center', 'top-left', 'center'] as const;
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

export type TimelineOverlay = {
  title?: string | undefined;
  subtitle?: string | undefined;
  position?: OverlayPosition | undefined;
};

export type TimelineTransition = {
  type: 'xfade';
  style: string;
  durationSec: number;
};

export type TimelineSegment = {
  id: string;
  image: string;
  durationSec: number | 'auto';
  motion?: Motion | undefined;
  transitionTo?: TimelineTransition | undefined;
  overlay?: TimelineOverlay | undefined;
  narration?: string | undefined;
};

export type TimelineSpec = {
  title?: string | undefined;
  output?:
    | { resolution?: string | undefined; fps?: number | undefined; codec?: string | undefined }
    | undefined;
  voice?: string | undefined;
  bgm?: string | null | undefined;
  ttsFailureMode?: 'fail' | 'silent-subtitles' | undefined;
  segments: TimelineSegment[];
};

const RESOLUTION_RE = /^(\d{3,4})x(\d{3,4})$/;
const MAX_OUTPUT_DIMENSION = 4096;
const XFADE_STYLES = new Set([
  'fade',
  'fadeblack',
  'fadewhite',
  'wipeleft',
  'wiperight',
  'slideup',
  'slidedown',
  'circlecrop',
  'dissolve',
]);

/** Manual validation with agent-fixable error messages (compose/render philosophy). */
export function parseTimelineSpec(raw: string): TimelineSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VideoGenError('timeline-input.json is not valid JSON.', 'timeline: spec not json');
  }
  const spec = parsed as TimelineSpec;
  if (
    !spec ||
    typeof spec !== 'object' ||
    !Array.isArray(spec.segments) ||
    spec.segments.length === 0
  ) {
    throw new VideoGenError(
      'timeline-input.json must contain a non-empty "segments" array.',
      'timeline: no segments',
    );
  }
  if (
    spec.output !== undefined &&
    (!spec.output || typeof spec.output !== 'object' || Array.isArray(spec.output))
  ) {
    throw new VideoGenError('output must be an object.', 'timeline: bad output');
  }
  if (spec.output?.resolution !== undefined) {
    const match =
      typeof spec.output.resolution === 'string'
        ? RESOLUTION_RE.exec(spec.output.resolution)
        : null;
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (
      !match ||
      width < 2 ||
      height < 2 ||
      width > MAX_OUTPUT_DIMENSION ||
      height > MAX_OUTPUT_DIMENSION ||
      width % 2 !== 0 ||
      height % 2 !== 0
    ) {
      throw new VideoGenError(
        `output.resolution must look like "1920x1080" with positive even dimensions no larger than ${MAX_OUTPUT_DIMENSION} (got "${spec.output.resolution}").`,
        'timeline: bad resolution',
      );
    }
  }
  if (
    spec.output?.fps !== undefined &&
    (!Number.isInteger(spec.output.fps) || spec.output.fps < 1 || spec.output.fps > 120)
  ) {
    throw new VideoGenError(
      `output.fps must be an integer 1-120 (got ${spec.output.fps}).`,
      'timeline: bad fps',
    );
  }

  const seen = new Set<string>();
  spec.segments.forEach((seg, i) => {
    const where = `segments[${i}]${seg?.id ? ` ("${seg.id}")` : ''}`;
    if (!seg || typeof seg !== 'object') {
      throw new VideoGenError(`${where} is not an object.`, 'timeline: bad segment');
    }
    if (
      seg.overlay !== undefined &&
      (!seg.overlay || typeof seg.overlay !== 'object' || Array.isArray(seg.overlay))
    ) {
      throw new VideoGenError(`${where}.overlay must be an object.`, 'timeline: bad overlay');
    }
    if (
      seg.transitionTo !== undefined &&
      (!seg.transitionTo || typeof seg.transitionTo !== 'object' || Array.isArray(seg.transitionTo))
    ) {
      throw new VideoGenError(
        `${where}.transitionTo must be an object.`,
        'timeline: bad transition',
      );
    }
    if (typeof seg.id !== 'string') {
      throw new VideoGenError(`${where}.id must be a string.`, 'timeline: id type');
    }
    assertSafeId(seg.id, 'segment');
    if (seen.has(seg.id)) {
      throw new VideoGenError(`Duplicate segment id "${seg.id}".`, 'timeline: dup id');
    }
    seen.add(seg.id);
    if (typeof seg.image !== 'string' || seg.image.trim() === '') {
      throw new VideoGenError(
        `${where}.image is required (path to a png/jpg from image_generate or a screenshot).`,
        'timeline: no image',
      );
    }
    if (seg.durationSec !== 'auto') {
      if (
        typeof seg.durationSec !== 'number' ||
        !Number.isFinite(seg.durationSec) ||
        seg.durationSec < 0.5 ||
        seg.durationSec > 300
      ) {
        throw new VideoGenError(
          `${where}.durationSec must be "auto" (from narration audio) or a number 0.5-300 (got ${JSON.stringify(seg.durationSec)}).`,
          'timeline: bad duration',
        );
      }
    } else if (!seg.narration) {
      throw new VideoGenError(
        `${where}: durationSec "auto" requires narration (the TTS audio decides the length).`,
        'timeline: auto without narration',
      );
    }
    if (seg.motion !== undefined && !MOTIONS.includes(seg.motion)) {
      throw new VideoGenError(
        `${where}.motion must be one of ${MOTIONS.join(', ')} (got "${seg.motion}").`,
        'timeline: bad motion',
      );
    }
    if (seg.transitionTo) {
      if (seg.transitionTo.type !== 'xfade') {
        throw new VideoGenError(
          `${where}.transitionTo.type must be "xfade" for now.`,
          'timeline: bad transition type',
        );
      }
      if (!XFADE_STYLES.has(seg.transitionTo.style)) {
        throw new VideoGenError(
          `${where}.transitionTo.style must be one of ${[...XFADE_STYLES].join(', ')} (got "${seg.transitionTo.style}").`,
          'timeline: bad transition style',
        );
      }
      const d = seg.transitionTo.durationSec;
      if (typeof d !== 'number' || d <= 0 || d > 3) {
        throw new VideoGenError(
          `${where}.transitionTo.durationSec must be 0-3s (got ${d}).`,
          'timeline: bad transition duration',
        );
      }
      if (typeof seg.durationSec === 'number' && d >= seg.durationSec) {
        throw new VideoGenError(
          `${where}: transitionTo.durationSec (${d}s) must be shorter than the segment duration (${seg.durationSec}s) — the overlap would swallow the whole segment.`,
          'timeline: transition too long',
        );
      }
    }
    if (seg.overlay?.position !== undefined && !OVERLAY_POSITIONS.includes(seg.overlay.position)) {
      throw new VideoGenError(
        `${where}.overlay.position must be one of ${OVERLAY_POSITIONS.join(', ')}.`,
        'timeline: bad overlay position',
      );
    }
    // Runtime string-type guards (bad JSON would otherwise explode later in
    // startsWith/resolve with unhelpful errors).
    if (seg.overlay?.title !== undefined && typeof seg.overlay.title !== 'string') {
      throw new VideoGenError(
        `${where}.overlay.title must be a string.`,
        'timeline: bad overlay title',
      );
    }
    if (seg.overlay?.subtitle !== undefined && typeof seg.overlay.subtitle !== 'string') {
      throw new VideoGenError(
        `${where}.overlay.subtitle must be a string.`,
        'timeline: bad overlay subtitle',
      );
    }
    if (seg.narration !== undefined && typeof seg.narration !== 'string') {
      throw new VideoGenError(`${where}.narration must be a string.`, 'timeline: bad narration');
    }
  });
  if (spec.title !== undefined && typeof spec.title !== 'string') {
    throw new VideoGenError('title must be a string.', 'timeline: bad title');
  }
  if (spec.voice !== undefined && (typeof spec.voice !== 'string' || spec.voice.trim() === '')) {
    throw new VideoGenError('voice must be a non-empty string.', 'timeline: bad voice');
  }
  if (
    spec.bgm !== undefined &&
    spec.bgm !== null &&
    (typeof spec.bgm !== 'string' || spec.bgm.trim() === '')
  ) {
    throw new VideoGenError('bgm must be a non-empty string path or null.', 'timeline: bad bgm');
  }
  if (
    spec.ttsFailureMode !== undefined &&
    !['fail', 'silent-subtitles'].includes(spec.ttsFailureMode)
  ) {
    throw new VideoGenError(
      'ttsFailureMode must be "fail" or "silent-subtitles".',
      'timeline: bad tts failure mode',
    );
  }
  if (spec.output?.codec !== undefined && !['mpeg4', 'h264'].includes(spec.output.codec)) {
    throw new VideoGenError(
      `output.codec must be "mpeg4" or "h264" (got "${spec.output.codec}").`,
      'timeline: bad codec',
    );
  }
  return spec;
}

/** Verify every referenced image exists as a regular file. */
export async function assertImagesReadable(
  spec: TimelineSpec,
  resolvePath: (p: string) => string,
): Promise<void> {
  for (const seg of spec.segments) {
    const st = await lstat(resolvePath(seg.image)).catch(() => null);
    if (!st?.isFile()) {
      throw new VideoGenError(
        `Segment "${seg.id}" image is not a readable file: ${safeBasename(seg.image)}. Generate it with image_generate first.`,
        'timeline: image unreadable',
      );
    }
  }
}
