import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concatVideos, resolveFfmpeg } from '../ffmpeg.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-ffmpeg');

describe('resolveFfmpeg', () => {
  beforeEach(() => {
    vi.stubEnv('FFMPEG_PATH', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(suiteDir, { recursive: true, force: true });
  });

  it('settings path wins and reports source', () => {
    const res = resolveFfmpeg('/custom/ffmpeg');
    expect(res.path).toBe('/custom/ffmpeg');
    expect(res.source).toBe('settings');
  });

  it('env FFMPEG_PATH is second', () => {
    vi.stubEnv('FFMPEG_PATH', '/env/ffmpeg');
    const res = resolveFfmpeg();
    expect(res.path).toBe('/env/ffmpeg');
    expect(res.source).toBe('env');
  });

  it('falls back to a bundled platform package or the development ffmpeg-static', () => {
    const res = resolveFfmpeg();
    expect(res.source).toBe('bundled');
    expect(res.path.includes('ffmpeg')).toBe(true);
    expect(res.runnable).toBe(true);
  });
});

describe('concatVideos', () => {
  let dir: string;
  let logPath: string;
  let fakeFfmpeg: string;

  beforeEach(() => {
    dir = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'args.log');
  });

  function writeFakeFfmpeg(copyFails: boolean): string {
    fakeFfmpeg = join(dir, 'fake-ffmpeg.sh');
    writeFileSync(
      fakeFfmpeg,
      [
        '#!/bin/sh',
        `echo "$@" >> "${logPath}"`,
        'for last; do :; done',
        copyFails ? 'echo "$@" | grep -q -- "-c copy" && exit 1' : ':',
        'printf "FAKEMP4" > "$last"',
        'exit 0',
      ].join('\n'),
    );
    chmodSync(fakeFfmpeg, 0o755);
    return fakeFfmpeg;
  }

  it('concatenates losslessly when -c copy works', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    writeFileSync(a, 'x');
    writeFileSync(b, 'x');
    const out = join(dir, 'final.mp4');

    await concatVideos({ inputs: [a, b], outputPath: out, ffmpegPath: ffmpeg });

    const log = readFileSync(logPath, 'utf-8');
    expect((log.match(/-f concat/g) ?? []).length).toBe(1);
    expect(log).toContain('-c copy');
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4');
  });

  it('falls back to libx264 re-encode when -c copy fails', async () => {
    const ffmpeg = writeFakeFfmpeg(true);
    const a = join(dir, 'a.mp4');
    const out = join(dir, 'final.mp4');
    writeFileSync(a, 'x');

    await concatVideos({ inputs: [a], outputPath: out, ffmpegPath: ffmpeg });

    const log = readFileSync(logPath, 'utf-8');
    expect((log.match(/-f concat/g) ?? []).length).toBe(2);
    expect(log).toContain('mpeg4'); // LGPL-clean fallback codec, never libx264
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4');
  });

  it('a pre-placed final_video symlink is replaced, never followed', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    writeFileSync(a, 'x');
    const victim = join(dir, 'victim.bin');
    writeFileSync(victim, 'precious');
    const out = join(dir, 'final.mp4');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, out, 'file');

    await concatVideos({ inputs: [a], outputPath: out, ffmpegPath: ffmpeg });

    expect(readFileSync(victim, 'utf-8')).toBe('precious'); // untouched
    expect(readFileSync(out, 'utf-8')).toBe('FAKEMP4'); // real output in place
    // list file and temp output are cleaned up
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it('leaves no concat-list files behind', async () => {
    const ffmpeg = writeFakeFfmpeg(false);
    const a = join(dir, 'a.mp4');
    writeFileSync(a, 'x');
    await concatVideos({ inputs: [a], outputPath: join(dir, 'final.mp4'), ffmpegPath: ffmpeg });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('concat-list'))).toHaveLength(0);
  });

  it('rejects empty input', async () => {
    await expect(
      concatVideos({ inputs: [], outputPath: join(dir, 'x.mp4'), ffmpegPath: 'ffmpeg' }),
    ).rejects.toThrow(/No clips/);
  });
});
