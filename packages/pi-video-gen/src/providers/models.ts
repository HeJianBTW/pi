import type { BuiltInVideoModel } from '../types.js';

/**
 * Built-in video model registry. Only models with a published request contract
 * belong here — no placeholders for announced-but-undocumented models
 * (Seedance 2.5 stays on the roadmap until its API ID and parameter contract
 * are officially published).
 *
 * Capability values reflect provider documentation as of 2026-07 and are
 * PENDING live verification (run /video-gen doctor + a small paid clip):
 * - Seedance 2.0: https://www.volcengine.com/docs/82379/1520757
 * - HappyHorse: https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference
 */
export const BUILT_IN_VIDEO_MODELS: BuiltInVideoModel[] = [
  {
    id: 'doubao-seedance-2-0-260128',
    aliases: ['seedance', 'seedance-2.0', 'seedance-std'],
    provider: 'ark',
    capabilities: {
      maxReferenceImages: 9,
      durations: [4, 15],
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      nativeAudio: true,
      supportsFirstLastFrame: true,
    },
    defaultResolution: '1080p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    aliases: ['seedance-fast'],
    provider: 'ark',
    capabilities: {
      maxReferenceImages: 9,
      durations: [4, 15],
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      nativeAudio: true,
      supportsFirstLastFrame: true,
    },
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    id: 'happyhorse-1.1',
    aliases: ['happyhorse', 'happyhorse-1.1'],
    provider: 'dashscope',
    capabilities: {
      maxReferenceImages: 9,
      durations: [3, 15],
      resolutions: ['720P', '1080P'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'],
      nativeAudio: false,
      supportsFirstLastFrame: false,
    },
    defaultResolution: '1080P',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    id: 'happyhorse-1.0',
    aliases: ['happyhorse-1.0'],
    provider: 'dashscope',
    capabilities: {
      maxReferenceImages: 9,
      durations: [3, 15],
      resolutions: ['720P', '1080P'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'],
      nativeAudio: false,
      supportsFirstLastFrame: false,
    },
    defaultResolution: '1080P',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    // Verified against kling.ai/document-api (2026-07): model id is the URL
    // path segment. Turbo: first-frame only, silent, 720p/1080p.
    id: 'kling-3.0-turbo',
    aliases: ['kling', 'kling-turbo', 'kling-v3-turbo'],
    provider: 'kling',
    capabilities: {
      maxReferenceImages: 1,
      durations: [3, 15],
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      nativeAudio: false,
      supportsFirstLastFrame: false,
    },
    defaultResolution: '1080p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    // Kling 3.0 "Omni": last_frame, native audio, 4k.
    id: 'kling-3.0',
    aliases: ['kling-omni', 'kling-v3-omni', 'kling-3.0-omni'],
    provider: 'kling',
    capabilities: {
      maxReferenceImages: 2,
      durations: [3, 15],
      resolutions: ['720p', '1080p', '4k'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      nativeAudio: true,
      supportsFirstLastFrame: true,
    },
    defaultResolution: '1080p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
  {
    // Per OpenRouter docs example (2026-07): 5s/8s, 720p, 16:9, audio, flf.
    // Live list: GET https://openrouter.ai/api/v1/videos/models
    id: 'google/veo-3.1',
    aliases: ['veo', 'veo-3.1'],
    provider: 'openrouter',
    capabilities: {
      maxReferenceImages: 2,
      durations: [5, 8],
      resolutions: ['720p'],
      aspectRatios: ['16:9'],
      nativeAudio: true,
      supportsFirstLastFrame: true,
    },
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 8,
  },
  {
    id: 'doubao-seedance-2-0-mini-260615',
    aliases: ['seedance-mini'],
    provider: 'ark',
    capabilities: {
      maxReferenceImages: 9,
      durations: [4, 15],
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      nativeAudio: true,
      supportsFirstLastFrame: true,
    },
    defaultResolution: '720p',
    defaultAspectRatio: '16:9',
    defaultDurationSec: 5,
  },
];

/** Resolve a model id or alias against the built-in registry. */
export function findBuiltInModel(idOrAlias: string): BuiltInVideoModel | undefined {
  const needle = idOrAlias.trim().toLowerCase();
  return BUILT_IN_VIDEO_MODELS.find(
    (m) => m.id.toLowerCase() === needle || m.aliases.some((a) => a.toLowerCase() === needle),
  );
}
