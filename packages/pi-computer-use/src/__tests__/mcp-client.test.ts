import { describe, expect, it } from 'vitest';
import { resolveBundledTarget, resolveDriverLayout, resolveUnixSocketPath } from '../mcp-client.js';

describe('CuaDriverClient', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-universal'],
    ['darwin', 'x64', 'darwin-universal'],
    ['linux', 'arm64', 'linux-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['win32', 'arm64', 'win32-arm64'],
    ['win32', 'x64', 'win32-x64'],
  ])('resolves %s/%s to %s', (platform, arch, expected) => {
    expect(resolveBundledTarget(platform, arch)).toBe(expected);
  });

  it('uses the bundled Rust app identity on macOS', () => {
    expect(resolveDriverLayout({ mode: 'bundled' }, '/package', 'darwin', 'arm64')).toEqual({
      appPath: '/package/bin/darwin-universal/CuaDriver.app',
      binaryPath: '/package/bin/darwin-universal/CuaDriver.app/Contents/MacOS/cua-driver',
      embedded: false,
    });
  });

  it('uses embedded mode for a custom macOS binary', () => {
    expect(
      resolveDriverLayout(
        { mode: 'path', binaryPath: '/opt/cua-driver' },
        '/package',
        'darwin',
        'arm64',
      ),
    ).toEqual({ binaryPath: '/opt/cua-driver', embedded: true });
  });

  it('falls back to /tmp when the configured temp path exceeds Unix socket limits', () => {
    const longTempDir = `/var/folders/${'nested/'.repeat(14)}T`;

    expect(resolveUnixSocketPath(longTempDir, '123-deadbeef')).toBe(
      '/tmp/pi-cua-123-deadbeef.sock',
    );
    expect(Buffer.byteLength(resolveUnixSocketPath('/tmp', '123-deadbeef'))).toBeLessThan(91);
  });
});
