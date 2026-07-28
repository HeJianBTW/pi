import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const platformsRoot = join(packageRoot, 'platforms');
const publishWorkflow = readFileSync(
  join(packageRoot, '..', '..', '.github', 'workflows', 'npm-publish.yml'),
  'utf-8',
);
const mainPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
  files: string[];
  optionalDependencies?: Record<string, string>;
};

const targets = [
  { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64', executable: 'ffmpeg' },
  { suffix: 'darwin-x64', os: 'darwin', cpu: 'x64', executable: 'ffmpeg' },
  {
    suffix: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    executable: 'ffmpeg',
    libc: ['glibc'],
  },
  { suffix: 'linux-x64', os: 'linux', cpu: 'x64', executable: 'ffmpeg', libc: ['glibc'] },
  { suffix: 'win32-x64', os: 'win32', cpu: 'x64', executable: 'ffmpeg.exe' },
] as const;

describe('pi-video-gen package artifacts', () => {
  it('installs FFmpeg through platform-specific optional packages', () => {
    expect(mainPackage.files).not.toContain('bin');
    expect(mainPackage.optionalDependencies).toEqual(
      Object.fromEntries(
        targets.map(({ suffix }) => [`@amaster.ai/pi-video-gen-ffmpeg-${suffix}`, 'workspace:*']),
      ),
    );
  });

  it('builds every platform from pinned FFmpeg source without external libraries', () => {
    const script = readFileSync(join(packageRoot, 'scripts', 'build-ffmpeg.sh'), 'utf-8');
    expect(script).toContain('FFMPEG_SHA256=');
    expect(script).toContain('--disable-autodetect');
    expect(script).toContain('--disable-everything');
    expect(script).toContain('MACOSX_DEPLOYMENT_TARGET=11.0');
    expect(script).not.toMatch(/--enable-lib[a-z0-9]/);
    for (const { suffix } of targets) expect(script).toContain(`${suffix})`);
  });

  it('builds against declared platform baselines and verifies release binaries', () => {
    expect(publishWorkflow).toContain('runner: ubuntu-22.04');
    expect(publishWorkflow).toContain('Verify FFmpeg binary');
    expect(publishWorkflow).toContain('vtool -show-build');
  });

  it('executes cross-compiled release binaries before publishing them', () => {
    expect(publishWorkflow).toContain('qemu-aarch64 -L /usr/aarch64-linux-gnu "$bin" -version');
    expect(publishWorkflow).toContain(`WINEDEBUG=-all /usr/lib/wine/wine64 "\${bin}.exe" -version`);
  });

  for (const target of targets) {
    it(`publishes only the ${target.suffix} FFmpeg executable for ${target.os}/${target.cpu}`, () => {
      const packageJson = JSON.parse(
        readFileSync(join(platformsRoot, `ffmpeg-${target.suffix}`, 'package.json'), 'utf-8'),
      ) as {
        os: string[];
        cpu: string[];
        libc?: string[];
        files: string[];
        bin?: Record<string, string>;
        publishConfig: { executableFiles: string[] };
        exports: Record<string, string>;
      };

      expect(packageJson.os).toEqual([target.os]);
      expect(packageJson.cpu).toEqual([target.cpu]);
      expect(packageJson.libc).toEqual('libc' in target ? target.libc : undefined);
      expect(packageJson.files).toEqual(['bin', 'LICENSE', 'SOURCE.md', 'source']);
      expect(packageJson.bin).toBeUndefined();
      expect(packageJson.publishConfig.executableFiles).toEqual([`./bin/${target.executable}`]);
      expect(packageJson.exports).toEqual({ './ffmpeg': `./bin/${target.executable}` });
    });
  }
});
