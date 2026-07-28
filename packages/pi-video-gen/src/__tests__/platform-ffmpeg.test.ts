import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveFfmpeg platform package', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.doUnmock('node:module');
    vi.resetModules();
  });

  it('uses the installed optional package for the current platform', async () => {
    const packageRequest = `@amaster.ai/pi-video-gen-ffmpeg-${process.platform}-${process.arch}/ffmpeg`;
    vi.doMock('node:fs', () => ({ existsSync: () => false }));
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: () => ({ status: 0 }),
    }));
    vi.doMock('node:module', () => ({
      createRequire: () =>
        Object.assign(() => '/dev/ffmpeg-static', {
          resolve: (request: string) => {
            if (request === packageRequest) return '/optional-package/bin/ffmpeg';
            throw new Error(`unexpected package: ${request}`);
          },
        }),
    }));

    const { resolveFfmpeg } = await import('../ffmpeg.js');

    expect(resolveFfmpeg()).toEqual({
      path: '/optional-package/bin/ffmpeg',
      source: 'bundled',
      runnable: true,
    });
  });

  it('falls back to PATH when installed bundled candidates are not runnable', async () => {
    const packageRequest = `@amaster.ai/pi-video-gen-ffmpeg-${process.platform}-${process.arch}/ffmpeg`;
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(),
      spawnSync: (path: string) => ({ status: path === 'ffmpeg' ? 0 : 1 }),
    }));
    vi.doMock('node:module', () => ({
      createRequire: () =>
        Object.assign(() => '/dev/ffmpeg-static', {
          resolve: (request: string) => {
            if (request === packageRequest) return '/optional-package/bin/ffmpeg';
            throw new Error(`unexpected package: ${request}`);
          },
        }),
    }));

    const { resolveFfmpeg } = await import('../ffmpeg.js');

    expect(resolveFfmpeg()).toEqual({
      path: 'ffmpeg',
      source: 'path',
      runnable: true,
    });
  });
});
