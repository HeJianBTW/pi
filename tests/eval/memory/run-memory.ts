#!/usr/bin/env node
/**
 * Run pi-memory (curated MemoryStore) against LoCoMo as a SIMPLIFIED probe.
 *
 * pi-memory has no semantic retrieval — its job is to decide what to keep
 * within the 2200/1375 char budget. So this runner:
 *   1. Feeds turns one by one, asking an extractor LLM to call memory_add /
 *      memory_replace / memory_remove. (LLM not wired in skeleton — we use
 *      a heuristic baseline: append every assistant-stated fact, FIFO evict.)
 *   2. After ingest, for each QA, scores whether the gold answer's tokens
 *      appear inside MEMORY.md + USER.md.
 *
 * This is NOT a fair head-to-head vs mem0 — see eval/README.md.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '@amaster.ai/pi-memory/store';
import { loadLocomo } from '../src/loaders/locomo.js';
import { tokenF1 } from '../src/judge.js';

interface Args {
  samples: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  return { samples: Number(get('--samples', '3')) };
}

async function main() {
  const args = parseArgs();
  const samples = (await loadLocomo()).slice(0, args.samples);
  process.stderr.write(`[eval:memory] loaded ${samples.length} samples\n`);

  const rows: Array<{ sample: string; question: string; gold: string; f1: number; charsUsed: number }> = [];

  for (const s of samples) {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-memory-eval-'));
    const store = new MemoryStore({ dir });
    try {
      await store.loadFromDisk();
      // Heuristic baseline: speaker_b turns → MEMORY (the agent's own notes
      // in pi-memory terms), speaker_a turns → USER profile. First line, ≤300 chars.
      for (const t of s.turns) {
        const text = (t.text ?? '').trim();
        if (!text) continue;
        const target = t.speaker === s.speakerA ? 'user' : 'memory';
        const entry = text.split(/\n/)[0].slice(0, 300);
        const res = await store.add(target, entry);
        if ('success' in res && res.success === false) {
          // Likely over-limit. FIFO evict the oldest entry, retry once.
          const entries = store.getEntries(target);
          if (entries.length > 0) {
            await store.remove(target, entries[0].slice(0, 24));
            await store.add(target, entry);
          }
        }
      }
      const blob = [...store.getEntries('memory'), ...store.getEntries('user')].join('\n');
      for (const q of s.qa) {
        rows.push({
          sample: s.sampleId,
          question: q.question,
          gold: q.answer,
          f1: tokenF1(blob, q.answer).score,
          charsUsed: blob.length,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const avg = (k: 'f1' | 'charsUsed') => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
  const summary = { n: rows.length, tokenF1: avg('f1'), avgChars: avg('charsUsed') };
  process.stderr.write(`[eval:memory] ${JSON.stringify(summary)}\n`);

  const outDir = path.resolve(import.meta.dirname, '..', 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'memory-locomo.json'), JSON.stringify({ summary, rows }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[eval:memory] error: ${err.message}\n`);
  process.exit(1);
});
