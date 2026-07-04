#!/usr/bin/env node
/**
 * Fetch LoCoMo benchmark JSON into datasets/locomo/.
 * Source: https://github.com/snap-research/locomo (MIT). We pull the raw JSON
 * directly from the upstream repo, NOT from OpenDataBox/MemoryData (unlicensed).
 *
 * Usage: pnpm --filter @amaster.ai/pi-memory-eval fetch:locomo
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  {
    name: 'locomo10.json',
    url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
  },
];

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'datasets', 'locomo');

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const t of TARGETS) {
    const out = path.join(OUT_DIR, t.name);
    process.stderr.write(`[fetch-locomo] ${t.url} -> ${out}\n`);
    const res = await fetch(t.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${t.url}`);
    const body = await res.text();
    await writeFile(out, body);
  }
  process.stderr.write('[fetch-locomo] done\n');
}

main().catch((err) => {
  process.stderr.write(`[fetch-locomo] error: ${err.message}\n`);
  process.exit(1);
});
