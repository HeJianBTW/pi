import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({
  armed: false,
  sourcePath: '',
  linkPath: '',
  replacementTarget: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    realpath: async (value: Parameters<typeof original.realpath>[0]) => {
      const canonical = await original.realpath(value);
      if (race.armed && String(value) === race.sourcePath) {
        race.armed = false;
        unlinkSync(race.linkPath);
        symlinkSync(race.replacementTarget, race.linkPath, 'dir');
      }
      return canonical;
    },
  };
});

const { readApprovedFrame } = await import('../frame-input.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG = Buffer.from('ffd8ff', 'hex');
const tempDirs: string[] = [];

afterEach(() => {
  race.armed = false;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readApprovedFrame race resistance', () => {
  it('keeps reading the approved inode when an ancestor symlink changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-video-frame-race-'));
    const outside = mkdtempSync(join(tmpdir(), 'pi-video-frame-race-outside-'));
    tempDirs.push(cwd, outside);
    const inside = join(cwd, 'inside');
    const link = join(cwd, 'frames');
    const source = join(link, 'frame.png');
    mkdirSync(inside);
    writeFileSync(join(inside, 'frame.png'), PNG);
    writeFileSync(join(outside, 'frame.png'), JPEG);
    symlinkSync(inside, link, 'dir');
    Object.assign(race, {
      armed: true,
      sourcePath: source,
      linkPath: link,
      replacementTarget: outside,
    });

    await expect(readApprovedFrame(source, cwd)).resolves.toEqual(PNG);
  });
});
