import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { VideoGenError } from './errors.js';

const MAX_FRAME_BYTES = 20 * 1024 * 1024;

function isInside(relativePath: string): boolean {
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function isSupportedImage(bytes: Uint8Array): boolean {
  return (
    (bytes.length >= 8 &&
      Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )) ||
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP')
  );
}

export async function readApprovedFrame(sourcePath: string, cwd: string): Promise<Buffer> {
  const absolute = resolve(cwd, sourcePath);
  const lexicalRoot = resolve(cwd);
  const lexicalRelative = relative(lexicalRoot, absolute);
  if (!isInside(lexicalRelative)) {
    throw new VideoGenError(
      'Reference frame must be inside the approved project directory.',
      'frame: outside cwd',
    );
  }

  const info = await lstat(absolute).catch(() => null);
  if (!info) throw new VideoGenError('Reference frame is not readable.', 'frame: unreadable');
  if (info.isSymbolicLink()) {
    throw new VideoGenError('Reference frame must not be a symlink.', 'frame: symlink');
  }
  if (!info.isFile()) {
    throw new VideoGenError('Reference frame must be a regular file.', 'frame: not regular');
  }
  if (info.size > MAX_FRAME_BYTES) {
    throw new VideoGenError('Reference frame exceeds the size ceiling.', 'frame: too large');
  }

  const root = await realpath(cwd);
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedInfo = await file.stat();
    if (!openedInfo.isFile() || openedInfo.size > MAX_FRAME_BYTES) {
      throw new VideoGenError('Reference frame is invalid or too large.', 'frame: invalid');
    }
    const canonical = await realpath(absolute);
    const canonicalInfo = await lstat(canonical);
    const canonicalRelative = relative(root, canonical);
    if (!isInside(canonicalRelative)) {
      throw new VideoGenError(
        'Reference frame must be inside the approved project directory.',
        'frame: outside cwd',
      );
    }
    if (openedInfo.dev !== canonicalInfo.dev || openedInfo.ino !== canonicalInfo.ino) {
      throw new VideoGenError(
        'Reference frame changed while it was being validated.',
        'frame: changed during validation',
      );
    }
    const bytes = await file.readFile();
    if (!isSupportedImage(bytes)) {
      throw new VideoGenError(
        'Reference frame is not a valid image (png, jpg, or webp required).',
        'frame: invalid image',
      );
    }
    return bytes;
  } finally {
    await file.close();
  }
}
