import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError } from '../providers/task.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  setMetadata: vi.fn(),
  toFile: vi.fn(),
}));

vi.mock('msedge-tts', () => ({
  MsEdgeTTS: vi.fn(function MockMsEdgeTTS() {
    return mocks;
  }),
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' },
}));

import { edgeTtsProvider } from '../tts/edge-tts.js';

describe('edge TTS provider', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-video-gen-edge-tts-'));
    mocks.close.mockReset();
    mocks.setMetadata.mockReset();
    mocks.toFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('cancels while the WebSocket metadata connection is opening', async () => {
    const controller = new AbortController();
    let rejectMetadata: ((error: Error) => void) | undefined;
    mocks.setMetadata.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMetadata = reject;
        }),
    );
    mocks.close.mockImplementation(() => rejectMetadata?.(new Error('closed')));

    const synthesis = edgeTtsProvider.synthesize({
      text: '取消测试',
      voice: 'zh-CN-YunyangNeural',
      outPath: join(cwd, 'audio.mp3'),
      signal: controller.signal,
    });
    controller.abort();

    await expect(
      Promise.race([
        synthesis,
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
      ]),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.toFile).not.toHaveBeenCalled();
  });

  it('does not follow a pre-placed work-directory symlink', async () => {
    const outPath = join(cwd, 'audio.mp3');
    const outside = join(cwd, 'outside');
    mkdirSync(outside);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    symlinkSync(outside, `${outPath}.work-${process.pid}-`, 'dir');
    mocks.setMetadata.mockResolvedValue(undefined);
    mocks.toFile.mockImplementation((workDir: string) => {
      const audioFilePath = join(workDir, 'audio.mp3');
      writeFileSync(audioFilePath, 'audio');
      writeFileSync(join(workDir, 'leak.txt'), 'outside write');
      return Promise.resolve({ audioFilePath, metadataFilePath: null });
    });

    await edgeTtsProvider.synthesize({
      text: '路径测试',
      voice: 'zh-CN-YunyangNeural',
      outPath,
    });

    expect(existsSync(join(outside, 'leak.txt'))).toBe(false);
    expect(existsSync(outPath)).toBe(true);
  });
});
