import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Catches the OLD "hash the source buffer" implementation deterministically:
 * if the source mutates BETWEEN the pre-copy read and the copy itself, the old
 * code froze hash(old bytes) while the snapshot holds new bytes. The correct
 * implementation hashes the SNAPSHOT after copy, so it must always match the
 * on-disk snapshot content.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(async (src: string, dest: string) => {
      // mutate the source mid-copy: the snapshot will hold 'v2-mutated'
      writeFileSync(src, 'v2-mutated');
      return actual.copyFile(src, dest);
    }),
  };
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveModel } from '../config.js';
import { ActiveJobs, loadRenderJob } from '../jobs/store.js';
import { requestFingerprint } from '../providers/request.js';
import { RateLimiter } from '../providers/task.js';
import { runRender } from '../render.js';
import type { VideoProviderAdapter } from '../types.js';

const suiteDir = join(tmpdir(), 'pi-video-gen-snap-hash');
afterEach(() => rmSync(suiteDir, { recursive: true, force: true }));

describe('snapshot hash is of the SNAPSHOT bytes (not a pre-copy source read)', () => {
  it('manifest hash equals sha256 of the on-disk snapshot after mid-copy mutation', async () => {
    const cwd = join(suiteDir, `run-${Math.random().toString(36).slice(2, 8)}`);
    const jobDir = join(cwd, '.video-gen', 'job-x');
    mkdirSync(join(cwd, 'frames'), { recursive: true });
    mkdirSync(jobDir, { recursive: true });
    const frame = join(cwd, 'frames', 'a.png');
    writeFileSync(frame, 'v1-original');
    writeFileSync(
      join(jobDir, 'render-input.json'),
      JSON.stringify({ shots: [{ id: 's1', videoPrompt: 'm1', firstFramePath: frame }] }),
    );

    const adapter: VideoProviderAdapter = {
      async submit(_provider, model, params) {
        return {
          taskId: 't-1',
          submittedAt: 'x',
          requestFingerprint: requestFingerprint(model, params),
        };
      },
      async inspect() {
        return { phase: 'succeeded', videoUrl: 'https://cdn.example/v.mp4' };
      },
      async downloadTo(_p, _h, _u, destPath) {
        writeFileSync(destPath, 'mp4');
        return { path: destPath, bytes: 3 };
      },
    };

    await runRender({
      renderSpecPath: join(jobDir, 'render-input.json'),
      settings: {},
      cwd,
      resolved: resolveModel({ providers: { ark: { apiKey: 'k' } } })!,
      adapter,
      activeJobs: new ActiveJobs(),
      rateLimiter: new RateLimiter(),
      ffmpegPath: 'unused',
      concatImpl: (async () => {}) as never,
    });

    const manifest = loadRenderJob(jobDir)!;
    const snapPath = join(jobDir, 'shots', 's1', 'first_frame.png');
    const snapBytes = readFileSync(snapPath);
    expect(snapBytes.toString()).toBe('v2-mutated'); // the mutation landed in the snapshot
    const expectHash = createHash('sha256').update(snapBytes).digest('hex');
    // OLD implementation (hash of pre-copy read 'v1-original') would FAIL here.
    expect(manifest.frameHashes[join('shots', 's1', 'first_frame.png')]).toBe(expectHash);
  });
});
