import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import toolManifest from '../generated/cua-driver-tools.js';

function plistStringValue(plist: string, key: string): string | undefined {
  return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
}

describe('bundled tool manifest', () => {
  it('matches the bundled macOS driver version metadata', () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const releaseTag = readFileSync(
      resolve(packageDir, 'bin/darwin-universal/.version'),
      'utf8',
    ).split(/\r?\n/, 1)[0];
    const infoPlist = readFileSync(
      resolve(packageDir, 'bin/darwin-universal/CuaDriver.app/Contents/Info.plist'),
      'utf8',
    );

    expect(releaseTag).toBe(`cua-driver-rs-v${toolManifest.driverVersion}`);
    expect(plistStringValue(infoPlist, 'CFBundleShortVersionString')).toBe(
      toolManifest.driverVersion,
    );
    expect(plistStringValue(infoPlist, 'CFBundleVersion')).toBe(toolManifest.driverVersion);
  });
});
