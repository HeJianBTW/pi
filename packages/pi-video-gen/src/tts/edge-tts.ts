import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { CancelledError } from '../providers/task.js';

/**
 * TTS provider seam (C2). Default: Microsoft Edge neural voices via
 * `msedge-tts` — free, no API key, high quality (zh-CN-YunyangNeural & co).
 * The interface is deliberately tiny so ElevenLabs/MiniMax/OpenAI TTS can
 * slot in behind the same seam later.
 */

export type TtsResult = {
  audioPath: string;
};

export type TtsProvider = {
  name: string;
  synthesize(opts: {
    text: string;
    voice: string;
    outPath: string;
    signal?: AbortSignal | undefined;
  }): Promise<TtsResult>;
};

/** Parse a voice reference like "edge-tts:zh-CN-YunyangNeural" → voice name. */
export function parseVoiceRef(ref: string | undefined): string {
  if (!ref) return 'zh-CN-YunyangNeural';
  return ref.startsWith('edge-tts:') ? ref.slice('edge-tts:'.length) : ref;
}

export const edgeTtsProvider: TtsProvider = {
  name: 'edge-tts',
  async synthesize({ text, voice, outPath, signal }) {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    mkdirSync(dirname(outPath), { recursive: true });
    const workDir = mkdtempSync(`${outPath}.work-`);

    const tts = new MsEdgeTTS();

    try {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        tts.close();
      };
      signal?.addEventListener('abort', close, { once: true });
      try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        if (signal?.aborted) throw new CancelledError();

        const result = await tts.toFile(workDir, text);
        if (signal?.aborted) throw new CancelledError();

        const produced = result.audioFilePath ?? `${workDir}/audio.mp3`;
        renameSync(produced, outPath);
        return { audioPath: outPath };
      } catch (error) {
        if (signal?.aborted) throw new CancelledError();
        throw error;
      } finally {
        signal?.removeEventListener('abort', close);
        close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  },
};
