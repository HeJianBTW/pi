import { spawn, spawnSync } from 'node:child_process';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { VideoGenError } from './errors.js';

/**
 * Lazily resolve an ffmpeg binary without crashing when node_modules is
 * absent (extension path loading does not install dependencies).
 * Priority: platform-specific optional npm package →
 * ffmpeg-static npm package (devDependency, dev machines only).
 */
const localRequire = createRequire(import.meta.url);

const platformBin = (() => {
  try {
    return localRequire.resolve(
      `@amaster.ai/pi-video-gen-ffmpeg-${process.platform}-${process.arch}/ffmpeg`,
    );
  } catch {
    return null;
  }
})();

const ffmpegStatic = (() => {
  try {
    return localRequire('ffmpeg-static') as string | null;
  } catch {
    return null; // devDependency not installed — PATH fallback remains
  }
})();

/**
 * ffmpeg resolution and video assembly.
 *
 * Resolution order: `pi-video-gen.ffmpegPath` (sensitive — global / agent-dir
 * settings only) → `FFMPEG_PATH` env → platform-specific optional npm package
 * → `ffmpeg-static` in node_modules (dev fallback) → `ffmpeg` on PATH. The
 * doctor reports which source resolved.
 */

export type FfmpegSource = 'settings' | 'env' | 'bundled' | 'path';

export type FfmpegResolution = {
  path: string;
  source: FfmpegSource;
  runnable: boolean;
};

export function resolveFfmpeg(settingsPath?: string | undefined): FfmpegResolution {
  if (settingsPath)
    return { path: settingsPath, source: 'settings', runnable: isRunnable(settingsPath) };
  if (process.env.FFMPEG_PATH) {
    return {
      path: process.env.FFMPEG_PATH,
      source: 'env',
      runnable: isRunnable(process.env.FFMPEG_PATH),
    };
  }
  if (platformBin && isRunnable(platformBin))
    return { path: platformBin, source: 'bundled', runnable: true };
  if (ffmpegStatic && isRunnable(ffmpegStatic))
    return { path: ffmpegStatic, source: 'bundled', runnable: true };
  return { path: 'ffmpeg', source: 'path', runnable: isRunnable('ffmpeg') };
}

function isRunnable(path: string): boolean {
  try {
    const res = spawnSync(path, ['-version'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail for the (body-free) error summary.
      stderrTail = (stderrTail + chunk.toString()).slice(-300);
    });
    child.on('error', () => {
      reject(
        new VideoGenError(
          `ffmpeg is not runnable at "${ffmpegPath}". Run /video-gen doctor.`,
          'ffmpeg: spawn failed',
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new VideoGenError(
            `ffmpeg failed (exit ${code}) while assembling the video. Retry once; if it persists, the shot clips may have mismatched encodings.`,
            `ffmpeg: exit ${code}`,
          ),
        );
      }
    });
  });
}

/**
 * Concatenate shot clips into the final video. Tries the lossless concat
 * demuxer (`-c copy`) first — same-codec clips join in seconds without
 * re-encoding; falls back to an mpeg4 re-encode when codecs/params differ
 * (mpeg4 is LGPL-clean — libx264 would REQUIRE a GPL build of ffmpeg).
 */
let concatCounter = 0;

export async function concatVideos(opts: {
  inputs: string[];
  outputPath: string;
  ffmpegPath: string;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  if (opts.inputs.length === 0) {
    throw new VideoGenError('No clips to concatenate.', 'concat: empty inputs');
  }
  const dir = dirname(opts.outputPath);
  const salt = `${process.pid}-${concatCounter++}-${Math.random().toString(36).slice(2, 8)}`;
  // Exclusive-create the concat list: a pre-placed symlink at a predictable
  // list path must fail, never be followed.
  const listPath = join(dir, `.concat-list-${salt}.txt`);
  // ffconcat single-quote escaping: an embedded ' would break the demuxer
  // ("O'Brien/project") — close-quote, escaped quote, reopen.
  await writeFile(
    listPath,
    opts.inputs.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'),
    {
      encoding: 'utf-8',
      flag: 'wx',
    },
  );
  // ffmpeg writes to an UNPREDICTABLE temp name, then atomic rename replaces
  // the final entry — a pre-placed final_video.mp4 symlink is replaced, never
  // followed, so no bytes land outside the job.
  const tmpOut = `${opts.outputPath}.tmp-${salt}.mp4`; // keep the .mp4 suffix — ffmpeg infers the muxer from it

  try {
    try {
      await runFfmpeg(
        opts.ffmpegPath,
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', tmpOut],
        opts.signal,
      );
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      await runFfmpeg(
        opts.ffmpegPath,
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:v',
          'mpeg4',
          '-q:v',
          '5',
          '-pix_fmt',
          'yuv420p',
          tmpOut,
        ],
        opts.signal,
      );
    }
    await rename(tmpOut, opts.outputPath);
  } finally {
    await unlink(listPath).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
