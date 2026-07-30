import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeDuration, probeStreams, resolveFfprobe } from '../ffmpeg.js';
import { ActiveJobs, hashFileSha256, loadTimelineJob } from '../jobs/store.js';
import { CancelledError } from '../providers/task.js';
import { renderTextOverlay } from '../text-layer.js';
import { runTimeline } from '../timeline-render.js';
import type { TtsProvider } from '../tts/edge-tts.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-timeline');
const require = createRequire(import.meta.url);
const ffmpegStaticBin = require('ffmpeg-static') as string;

async function makeImage(
  dir: string,
  name: string,
  color: { r: number; g: number; b: number },
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  await sharp({ create: { width: 640, height: 360, channels: 3, background: color } })
    .png()
    .toFile(p);
  return p;
}

/** Fake TTS: writes a real (sine) mp3 via ffmpeg-static and returns its duration. */
const fakeTts: TtsProvider = {
  name: 'fake',
  async synthesize({ outPath }) {
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '2',
        '-c:a',
        'libmp3lame',
        outPath,
      ],
      {
        stdio: 'ignore',
      },
    );
    return { audioPath: outPath };
  },
};

function baseOpts(cwd: string) {
  return { cwd, settings: {}, activeJobs: new ActiveJobs(), tts: fakeTts };
}

function parseSrtTimestamp(value: string): number {
  const [hours, minutes, seconds, milliseconds] = value.split(/[:,]/).map(Number);
  return hours! * 3600 + minutes! * 60 + seconds! + milliseconds! / 1000;
}

describe('timeline pipeline (C1–C3)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('renders a text overlay PNG via sharp', async () => {
    const out = join(cwd, 'ovr.png');
    const result = await renderTextOverlay({
      overlay: { title: 'Title test', subtitle: 'subtitle here', position: 'bottom-left' },
      width: 640,
      height: 360,
      outPath: out,
    });
    expect(result).toBe(out);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
    // not a blank image — the plate + text produce non-uniform pixels
    const stats = await sharp(out).stats();
    expect(stats.channels[0]!.max).toBeGreaterThan(0);
  });

  it('keeps title and subtitle on separate text rows', async () => {
    const out = join(cwd, 'separate-lines.png');
    await renderTextOverlay({
      overlay: { title: 'TITLE', subtitle: 'subtitle', position: 'top-left' },
      width: 640,
      height: 360,
      outPath: out,
    });

    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const brightRows: number[] = [];
    for (let y = 0; y < info.height; y += 1) {
      let hasText = false;
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (data[offset]! > 180 && data[offset + 3]! > 0) {
          hasText = true;
          break;
        }
      }
      if (hasText) brightRows.push(y);
    }
    const gaps = brightRows
      .slice(1)
      .map((row, index) => row - brightRows[index]!)
      .filter((gap) => gap > 1);
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('records a cancelled manifest when local rendering is aborted', async () => {
    const image = await makeImage(cwd, 'cancel.png', { r: 20, g: 30, b: 40 });
    const jobDir = join(cwd, '.video-gen', 'cancel-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, motion: 'static' }],
      }),
    );
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'cancelled' });
  });

  it('uses voice and BGM from the immutable timeline spec', async () => {
    const image = await makeImage(cwd, 'override.png', { r: 50, g: 60, b: 70 });
    const specBgm = join(cwd, 'spec-bgm.mp3');
    writeFileSync(specBgm, 'spec bgm bytes');
    const jobDir = join(cwd, '.video-gen', 'override-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        voice: 'edge-tts:spec-voice',
        bgm: specBgm,
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: 'hello' }],
      }),
    );
    let usedVoice = '';
    const capturingTts: TtsProvider = {
      name: 'capturing',
      async synthesize(options) {
        usedVoice = options.voice;
        return fakeTts.synthesize(options);
      },
    };
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      tts: capturingTts,
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(usedVoice).toBe('spec-voice');
    expect(readFileSync(join(jobDir, 'assets', 'bgm.mp3'), 'utf-8')).toBe('spec bgm bytes');
  });

  it('can explicitly degrade a TTS failure to silent audio with subtitles', async () => {
    const image = await makeImage(cwd, 'tts-fallback.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'tts-fallback-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        output: { resolution: '640x360', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: '旁白服务暂时不可用' }],
      }),
    );
    const failingTts: TtsProvider = {
      name: 'failing',
      async synthesize() {
        throw new Error('remote TTS unavailable');
      },
    };

    const result = await runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      tts: failingTts,
    });

    expect(loadTimelineJob(jobDir)).toMatchObject({
      state: 'done',
      segments: { s1: { narrationDegraded: true } },
    });
    expect(readFileSync(result.subtitlePath!, 'utf-8')).toContain('旁白服务暂时不可用');
    const streams = await probeStreams(resolveFfprobe().path, result.finalVideoPath);
    expect(streams.audioLayout).not.toBe('none');
    expect(streams.subtitleCodec).toBe('mov_text');
  });

  it('keeps an explicitly degraded segment silent on identical resume', async () => {
    const image = await makeImage(cwd, 'tts-resume.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'tts-resume-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1, narration: '保持静音降级' }],
      }),
    );
    const failingTts: TtsProvider = {
      name: 'failing',
      async synthesize() {
        throw new Error('remote TTS unavailable');
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: failingTts });
    const audioBefore = readFileSync(join(jobDir, 'audio_track.mp4'));

    let retried = 0;
    const recoveredTts: TtsProvider = {
      ...fakeTts,
      async synthesize(opts) {
        retried += 1;
        return fakeTts.synthesize(opts);
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: recoveredTts });

    expect(retried).toBe(0);
    expect(loadTimelineJob(jobDir)).toMatchObject({
      state: 'done',
      segments: { s1: { narrationDegraded: true } },
    });
    expect(readFileSync(join(jobDir, 'audio_track.mp4'))).toEqual(audioBefore);
  });

  it('does not misclassify an invalid encoded narration as a TTS degradation', async () => {
    const image = await makeImage(cwd, 'bad-audio.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'bad-audio-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        segments: [{ id: 's1', image, durationSec: 1, narration: '损坏音频' }],
      }),
    );
    const corruptTts: TtsProvider = {
      name: 'corrupt',
      async synthesize({ outPath }) {
        writeFileSync(outPath, 'not an mp3');
        return { audioPath: outPath };
      },
    };

    await expect(
      runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: corruptTts }),
    ).rejects.toThrow(/ffprobe failed/);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'failed' });

    let retries = 0;
    const recoveredTts: TtsProvider = {
      ...fakeTts,
      async synthesize(opts) {
        retries += 1;
        return fakeTts.synthesize(opts);
      },
    };
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: recoveredTts });
    expect(retries).toBe(1);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'done' });
  });

  it('does not misclassify narration artifact validation failures as TTS degradation', async () => {
    const image = await makeImage(cwd, 'linked-audio.png', { r: 80, g: 90, b: 100 });
    const jobDir = join(cwd, '.video-gen', 'linked-audio-job');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        ttsFailureMode: 'silent-subtitles',
        segments: [{ id: 's1', image, durationSec: 1, narration: '路径校验失败' }],
      }),
    );
    const outside = join(cwd, 'outside.mp3');
    await fakeTts.synthesize({ text: 'outside', voice: 'fake', outPath: outside });
    const linkedTts: TtsProvider = {
      name: 'linked',
      async synthesize({ outPath }) {
        symlinkSync(outside, outPath);
        return { audioPath: outPath };
      },
    };

    await expect(
      runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd), tts: linkedTts }),
    ).rejects.toThrow(/cached artifact.*symlink/i);
    expect(loadTimelineJob(jobDir)).toMatchObject({ state: 'failed' });
  });

  it('renders a 3-segment promo with narration, xfade, subtitles, and QC', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 200, g: 40, b: 40 });
    const imgB = await makeImage(cwd, 'b.png', { r: 40, g: 120, b: 200 });
    const imgC = await makeImage(cwd, 'c.png', { r: 40, g: 180, b: 80 });
    const jobDir = join(cwd, '.video-gen', 'promo-1');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'timeline-input.json'),
      JSON.stringify({
        title: 'test promo',
        output: { resolution: '640x360', fps: 25 },
        segments: [
          {
            id: 's1',
            image: imgA,
            durationSec: 1.5,
            motion: 'kenburns-in',
            narration: '第一段旁白内容',
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 0.5 },
          },
          {
            id: 's2',
            image: imgB,
            durationSec: 'auto',
            narration: '第二段旁白内容',
            overlay: { title: 'Title', subtitle: 'Subtitle' },
          },
          { id: 's3', image: imgC, durationSec: 1.5, motion: 'static' },
        ],
      }),
    );

    const result = await runTimeline({
      timelineSpecPath: join(jobDir, 'timeline-input.json'),
      ...baseOpts(cwd),
    });

    expect(result.segments).toBe(3);
    expect(existsSync(result.finalVideoPath)).toBe(true);
    expect(result.subtitlePath && existsSync(result.subtitlePath)).toBe(true);
    expect(readFileSync(result.subtitlePath!, 'utf-8')).toContain('第一段旁白内容');
    expect(result.qcFrames).toHaveLength(3);
    for (const f of result.qcFrames) expect(existsSync(f)).toBe(true);

    // artifacts cached: overlays, audio, segments
    expect(existsSync(join(jobDir, 'overlays', 's2.png'))).toBe(true);
    expect(existsSync(join(jobDir, 'audio', 's1.mp3'))).toBe(true);
    expect(existsSync(join(jobDir, 'segments', 's1.mp4'))).toBe(true);

    // Narrated s1 grows to 2s audio + 0.6s pad + 0.5s outgoing xfade;
    // subtracting the overlap leaves the full narration and pad on screen.
    const ffprobe = resolveFfprobe();
    const dur = await probeDuration(ffprobe.path, result.finalVideoPath);
    expect(dur).toBeGreaterThan(6.5);
    expect(dur).toBeLessThan(7);

    const manifest = loadTimelineJob(jobDir)!;
    expect(manifest.state).toBe('done');

    // mov_text subtitle track present in the final video
    const streams = await probeStreams(ffprobe.path, result.finalVideoPath);
    expect(streams.audioLayout).not.toBe('none');
    expect(streams.subtitleCodec).toBe('mov_text');
  }, 15_000);

  it('keeps narration and subtitles aligned across a long xfade', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 200, g: 40, b: 40 });
    const imgB = await makeImage(cwd, 'b.png', { r: 40, g: 120, b: 200 });
    const jobDir = join(cwd, '.video-gen', 'long-xfade');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image: imgA,
            durationSec: 'auto',
            narration: '第一段旁白',
            transitionTo: { type: 'xfade', style: 'fade', durationSec: 1 },
          },
          { id: 's2', image: imgB, durationSec: 'auto', narration: '第二段旁白' },
        ],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const ffprobe = resolveFfprobe();
    const videoDuration = await probeDuration(ffprobe.path, join(jobDir, 'video_track.mp4'));
    const audioDuration = await probeDuration(ffprobe.path, join(jobDir, 'audio_track.mp4'));

    expect(Math.abs(audioDuration - videoDuration)).toBeLessThan(0.1);
    const manifest = loadTimelineJob(jobDir)!;
    const cues = [
      ...readFileSync(result.subtitlePath!, 'utf-8').matchAll(
        /(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g,
      ),
    ].map((match) => ({
      start: parseSrtTimestamp(match[1]!),
      end: parseSrtTimestamp(match[2]!),
    }));
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(0);
    expect(cues[0]!.end).toBeCloseTo(manifest.segments.s1!.narrationDurationSec!, 2);
    expect(cues[1]!.start - cues[0]!.end).toBeCloseTo(0.6, 2);
    expect(cues[1]!.end - cues[1]!.start).toBeCloseTo(
      manifest.segments.s2!.narrationDurationSec!,
      2,
    );
  });

  it('resolves auto duration from the encoded narration', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 80, g: 120, b: 180 });
    const jobDir = join(cwd, '.video-gen', 'audio-duration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 'auto', narration: '旁白' }],
      }),
    );
    const result = await runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
    });

    expect(result.durationSec).toBeGreaterThan(2.5);
    expect(loadTimelineJob(jobDir)!.segments.s1!.narrationDurationSec).toBeGreaterThan(1.9);
  });

  it('resumes from cached artifacts on identical rerun', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 50, g: 50, b: 200 });
    const imgB = await makeImage(cwd, 'b.png', { r: 200, g: 50, b: 50 });
    const jobDir = join(cwd, '.video-gen', 'promo-2');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '640x360', fps: 25 },
        segments: [
          { id: 's1', image: imgA, durationSec: 1, narration: '旁白一' },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const segMtime = readFileSync(join(jobDir, 'segments', 's1.mp4')).byteLength;
    const frozenImageInode = statSync(join(jobDir, 'assets', 's1.png')).ino;

    const again = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(existsSync(again.finalVideoPath)).toBe(true);
    expect(again.subtitlePath && existsSync(again.subtitlePath)).toBe(true);
    expect(readFileSync(join(jobDir, 'segments', 's1.mp4')).byteLength).toBe(segMtime);
    expect(statSync(join(jobDir, 'assets', 's1.png')).ino).toBe(frozenImageInode);

    writeFileSync(join(jobDir, 'assets', 's1.png'), 'tampered frozen image');
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /Frozen image snapshot/,
    );
  });

  it('refuses to delete a pre-existing assets directory for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-assets');
    const assetsDir = join(jobDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    const keep = join(assetsDir, 'keep.txt');
    writeFileSync(keep, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /assets.*already exists/i,
    );
    expect(readFileSync(keep, 'utf-8')).toBe('user data');
    expect(loadTimelineJob(jobDir)).toBeUndefined();

    rmSync(assetsDir, { recursive: true });
    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    expect(existsSync(result.finalVideoPath)).toBe(true);
  });

  it('refuses to delete pre-existing derived outputs for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-outputs');
    const overlaysDir = join(jobDir, 'overlays');
    mkdirSync(overlaysDir, { recursive: true });
    const keep = join(overlaysDir, 'keep.png');
    writeFileSync(keep, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /overlays.*already exists/i,
    );
    expect(readFileSync(keep, 'utf-8')).toBe('user data');
  });

  it('refuses to replace a pre-existing final video for a fresh job', async () => {
    const image = await makeImage(cwd, 'source.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'existing-final');
    mkdirSync(jobDir, { recursive: true });
    const finalVideoPath = join(jobDir, 'final_video.mp4');
    writeFileSync(finalVideoPath, 'user data');
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final_video\.mp4.*already exists/i,
    );
    expect(readFileSync(finalVideoPath, 'utf-8')).toBe('user data');
  });

  it('refuses to rebuild a missing artifact that already has a committed hash', async () => {
    const image = await makeImage(cwd, 'missing-narration.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'missing-narration');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 'auto', narration: '不可重建的旁白' }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    rmSync(join(jobDir, 'audio', 's1.mp3'));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*missing/i,
    );
  });

  it('refuses a completed manifest with a missing upstream artifact hash', async () => {
    const image = await makeImage(cwd, 'sparse-done.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-done');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image,
            durationSec: 1,
            overlay: { title: 'Committed title' },
          },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    delete manifest.artifactHashes['overlays/s1.png'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed manifest.*missing.*artifact hash/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
  });

  it('validates cached audio inputs even when the mixed track is reusable', async () => {
    const image = await makeImage(cwd, 'sparse-audio.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-audio');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1 }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    delete manifest.artifactHashes['audio/s1_silence.mp4'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed manifest.*missing.*artifact hash/i,
    );
  });

  it('invalidates committed downstream artifacts before rebuilding an uncommitted upstream', async () => {
    const image = await makeImage(cwd, 'sparse-failed.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'sparse-failed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [
          {
            id: 's1',
            image,
            durationSec: 1,
            overlay: { title: 'Rebuilt title' },
          },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    manifest.state = 'failed';
    delete manifest.artifactHashes['overlays/s1.png'];
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Rendering segment')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(loadTimelineJob(jobDir)?.artifactHashes['segments/s1.mp4']).toBeUndefined();
  });

  it('invalidates QC artifacts before rebuilding an uncommitted final video', async () => {
    const image = await makeImage(cwd, 'stale-qc.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'stale-qc');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image, durationSec: 1 }],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    manifest.state = 'failed';
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));
    const controller = new AbortController();

    const running = runTimeline({
      timelineSpecPath: specPath,
      ...baseOpts(cwd),
      signal: controller.signal,
      onUpdate(message) {
        if (message.startsWith('Muxing final video')) controller.abort();
      },
    });

    await expect(running).rejects.toBeInstanceOf(CancelledError);
    const hashes = loadTimelineJob(jobDir)!.artifactHashes;
    expect(Object.keys(hashes).filter((key) => key.startsWith('qc/'))).toEqual([]);
  });

  it('refuses a cached segment replaced by a symlink', async () => {
    const image = await makeImage(cwd, 'segment-link.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'segment-link');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    const segmentPath = join(jobDir, 'segments', 's1.mp4');
    const outside = join(cwd, 'outside-segment.mp4');
    copyFileSync(segmentPath, outside);
    rmSync(segmentPath);
    symlinkSync(outside, segmentPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*symlink/i,
    );
  });

  it('refuses a cached segment whose bytes changed', async () => {
    const image = await makeImage(cwd, 'segment-changed.png', { r: 50, g: 70, b: 90 });
    const jobDir = join(cwd, '.video-gen', 'segment-changed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(specPath, JSON.stringify({ segments: [{ id: 's1', image, durationSec: 1 }] }));
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(join(jobDir, 'segments', 's1.mp4'), 'tampered segment');

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /cached artifact.*changed/i,
    );
  });

  it('refuses resume when the spec changed (revision ⇒ new job)', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 10, g: 10, b: 10 });
    const imgB = await makeImage(cwd, 'b.png', { r: 240, g: 240, b: 240 });
    const jobDir = join(cwd, '.video-gen', 'promo-3');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        segments: [
          { id: 's1', image: imgA, durationSec: 1 },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    writeFileSync(
      specPath,
      JSON.stringify({
        segments: [
          { id: 's1', image: imgA, durationSec: 2 },
          { id: 's2', image: imgB, durationSec: 1 },
        ],
      }),
    );
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /NEW job directory/,
    );
    expect(readdirSync(jobDir).filter((name) => name.startsWith('.assets-staging-'))).toEqual([]);
  });

  it('refuses a pre-placed QC output symlink', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'qc-symlink');
    const qcDir = join(jobDir, 'qc');
    mkdirSync(qcDir, { recursive: true });
    const outside = join(cwd, 'outside.png');
    writeFileSync(outside, 'do not overwrite');
    symlinkSync(outside, join(qcDir, 'qc_first.png'));
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /qc.*already exists/i,
    );

    expect(readFileSync(outside, 'utf-8')).toBe('do not overwrite');
    expect(lstatSync(join(qcDir, 'qc_first.png')).isSymbolicLink()).toBe(true);
  });

  it('refuses a fully pre-placed QC cache made of symlinks', async () => {
    const img = await makeImage(cwd, 'a.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'qc-cache-symlinks');
    const qcDir = join(jobDir, 'qc');
    mkdirSync(qcDir, { recursive: true });
    for (const name of ['qc_first.png', 'qc_mid.png', 'qc_last.png']) {
      symlinkSync(img, join(qcDir, name));
    }
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /qc.*already exists/i,
    );
  });

  it('refuses a completed final video replaced by a symlink', async () => {
    const img = await makeImage(cwd, 'final-symlink.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-symlink');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const outside = join(cwd, 'outside-final.mp4');
    copyFileSync(first.finalVideoPath, outside);
    rmSync(first.finalVideoPath);
    symlinkSync(outside, first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video.*invalid|changed|symlink/i,
    );
  });

  it('rejects a completed manifest whose final video path is not job-local', async () => {
    const img = await makeImage(cwd, 'final-path.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-path');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const manifest = loadTimelineJob(jobDir)!;
    writeFileSync(
      join(jobDir, 'manifest.json'),
      JSON.stringify({ ...manifest, finalVideoPath: join(cwd, 'outside.mp4') }),
    );

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video path/i,
    );
  });

  it('refuses a completed job whose final video is missing', async () => {
    const img = await makeImage(cwd, 'final-missing.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-missing');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 1 }],
      }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    rmSync(first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed final video.*missing/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /completed final video.*missing/i,
    );
    expect(loadTimelineJob(jobDir)?.state).toBe('done');
  });

  it('refuses a completed final video whose bytes changed', async () => {
    const img = await makeImage(cwd, 'final-changed.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'final-changed');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const replacement = join(cwd, 'replacement.mp4');
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=blue:size=1920x1080',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '1',
        '-c:v',
        'mpeg4',
        '-c:a',
        'aac',
        replacement,
      ],
      { stdio: 'ignore' },
    );
    copyFileSync(replacement, first.finalVideoPath);

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /final video.*changed/i,
    );
  });

  it('fails QC when the final video has no audio stream', async () => {
    const img = await makeImage(cwd, 'no-audio.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'no-audio');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({ segments: [{ id: 's1', image: img, durationSec: 1 }] }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    execFileSync(
      ffmpegStaticBin,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=blue:size=1920x1080',
        '-t',
        '1',
        '-c:v',
        'mpeg4',
        first.finalVideoPath,
      ],
      { stdio: 'ignore' },
    );
    const manifest = loadTimelineJob(jobDir)!;
    manifest.finalVideoHash = await hashFileSha256(first.finalVideoPath);
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /missing.*audio/i,
    );
  });

  it('fails QC when the cached SRT no longer matches the resolved timeline', async () => {
    const img = await makeImage(cwd, 'bad-srt.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'bad-srt');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 'auto', narration: '旁白时间轴' }],
      }),
    );
    const first = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });
    const subtitlePath = first.subtitlePath!;
    writeFileSync(subtitlePath, '1\n00:00:00,500 --> 00:00:01,000\n旁白时间轴\n');
    const manifest = loadTimelineJob(jobDir)!;
    manifest.artifactHashes['subtitles.srt'] = await hashFileSha256(subtitlePath);
    writeFileSync(join(jobDir, 'manifest.json'), JSON.stringify(manifest));

    await expect(runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) })).rejects.toThrow(
      /SRT timeline/i,
    );
  });

  it('extracts QC frames for the minimum valid 0.5-second timeline', async () => {
    const img = await makeImage(cwd, 'short.png', { r: 10, g: 20, b: 30 });
    const jobDir = join(cwd, '.video-gen', 'short');
    mkdirSync(jobDir, { recursive: true });
    const specPath = join(jobDir, 'timeline-input.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        output: { resolution: '320x180', fps: 25 },
        segments: [{ id: 's1', image: img, durationSec: 0.5 }],
      }),
    );

    const result = await runTimeline({ timelineSpecPath: specPath, ...baseOpts(cwd) });

    expect(result.qcFrames).toHaveLength(3);
    for (const frame of result.qcFrames) expect(existsSync(frame)).toBe(true);
  });

  it('validates bad specs before any rendering', async () => {
    const imgA = await makeImage(cwd, 'a.png', { r: 1, g: 2, b: 3 });
    const jobDir = join(cwd, '.video-gen', 'promo-bad');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'timeline-input.json'),
      JSON.stringify({ segments: [{ id: 's1', image: imgA, durationSec: 1, motion: 'fly' }] }),
    );
    await expect(
      runTimeline({ timelineSpecPath: join(jobDir, 'timeline-input.json'), ...baseOpts(cwd) }),
    ).rejects.toThrow(/motion must be one of/);
  });
});
