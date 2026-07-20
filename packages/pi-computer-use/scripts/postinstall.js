#!/usr/bin/env node
import { chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');

const platform =
  process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`;
const platformDir = join(binDir, platform);

if (process.platform === 'win32') {
  process.exit(0);
}

let binPath;
if (process.platform === 'darwin') {
  binPath = join(platformDir, 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver');
} else {
  binPath = join(platformDir, 'cua-driver');
}

if (existsSync(binPath)) {
  try {
    chmodSync(binPath, 0o755);
  } catch {
    // Non-fatal: runtime will retry or prompt user
  }
}
