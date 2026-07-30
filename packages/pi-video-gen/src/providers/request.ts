import { createHash } from 'node:crypto';
import type { GenerateVideoParams } from '../types.js';

/** Stable identity shared by orchestration and every provider adapter. */
export function requestFingerprint(remoteModelId: string, params: GenerateVideoParams): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: remoteModelId,
        requestId: params.requestId,
        prompt: params.prompt,
        firstFramePath: params.firstFramePath,
        lastFramePath: params.lastFramePath,
        referenceImagePaths: params.referenceImagePaths,
        durationSec: params.durationSec,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        generateAudio: params.generateAudio,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
