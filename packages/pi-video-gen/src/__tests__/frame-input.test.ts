import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readApprovedFrame } from '../frame-input.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const tempDirs: string[] = [];

function makeTempDir(prefix = 'pi-video-frame-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readApprovedFrame', () => {
  it('reads a regular image inside cwd', async () => {
    const cwd = makeTempDir();
    const path = join(cwd, 'frame.png');
    writeFileSync(path, PNG);
    await expect(readApprovedFrame(path, cwd)).resolves.toEqual(PNG);
  });

  it('allows a dot-prefixed child directory inside cwd', async () => {
    const cwd = makeTempDir();
    const directory = join(cwd, '..frames');
    mkdirSync(directory);
    const path = join(directory, 'frame.png');
    writeFileSync(path, PNG);

    await expect(readApprovedFrame(path, cwd)).resolves.toEqual(PNG);
  });

  it('rejects source paths outside cwd', async () => {
    const cwd = makeTempDir();
    const outside = makeTempDir('pi-video-frame-outside-');
    const path = join(outside, 'secret.png');
    writeFileSync(path, PNG);
    await expect(readApprovedFrame(path, cwd)).rejects.toThrow(/approved project directory/i);
  });

  it('rejects source symlinks and non-image bytes', async () => {
    const cwd = makeTempDir();
    const target = join(cwd, 'target.png');
    writeFileSync(target, PNG);
    const link = join(cwd, 'link.png');
    symlinkSync(target, link);
    await expect(readApprovedFrame(link, cwd)).rejects.toThrow(/symlink/i);

    const fake = join(cwd, 'fake.png');
    writeFileSync(fake, 'not an image');
    await expect(readApprovedFrame(fake, cwd)).rejects.toThrow(/valid image/i);
  });
});
