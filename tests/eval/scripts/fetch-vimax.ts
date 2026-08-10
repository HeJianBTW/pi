#!/usr/bin/env node
/**
 * Fetch ViMax-Bench story specs into datasets/vimax/.
 * Source: https://github.com/HKUDS/ViMax (MIT), vimax_benchmark/ — 35 multi-shot
 * story specs + benchmark_index.json. Data only: the scoring protocol lives in
 * the paper (arXiv 2606.07649) and is reimplemented in scripts/judge-video.ts.
 * Pinned to a commit so upstream edits don't silently shift the eval.
 *
 * Usage: pnpm --filter @amaster.ai/pi-eval fetch:vimax
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const COMMIT = '05a48943878312d88fe5a016c12a9654940ecc43';
const TREE_URL = `https://api.github.com/repos/HKUDS/ViMax/git/trees/${COMMIT}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/HKUDS/ViMax/${COMMIT}/`;
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'datasets', 'vimax');

async function main() {
  const res = await fetch(TREE_URL, { headers: { 'User-Agent': 'pi-eval' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${TREE_URL}`);
  const tree = (await res.json()) as { tree?: Array<{ path: string; type: string }> };
  const files = (tree.tree ?? [])
    .filter((e) => e.type === 'blob' && /^vimax_benchmark\/[^/]+\.json$/.test(e.path))
    .map((e) => e.path)
    .sort();
  if (files.length === 0) {
    throw new Error('no vimax_benchmark/*.json in pinned tree — upstream restructured?');
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const p of files) {
    const url = RAW_BASE + p;
    const out = path.join(OUT_DIR, path.basename(p));
    process.stderr.write(`[fetch-vimax] ${url} -> ${out}\n`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    await writeFile(out, await r.text());
  }
  process.stderr.write(`[fetch-vimax] done (${files.length} files @ ${COMMIT.slice(0, 7)})\n`);
}

main().catch((err) => {
  process.stderr.write(`[fetch-vimax] error: ${err.message}\n`);
  process.exit(1);
});
