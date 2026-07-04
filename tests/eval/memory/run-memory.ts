#!/usr/bin/env node
/**
 * Run pi-memory (curated MemoryStore) against LoCoMo with a REAL write loop.
 *
 * Unlike mem0's passive per-turn extraction, pi-memory is agent-driven: the
 * agent decides what to persist via memory_add / memory_replace / memory_remove
 * within a hard char budget (2200 MEMORY + 1375 USER). This runner simulates
 * that: for each conversation session, an LLM sees the turns plus the current
 * memory state and emits tool calls, which we apply to a real MemoryStore
 * (char limits + threat scan enforced).
 *
 * Then for each QA, an LLM answers using the full MEMORY.md + USER.md snapshot
 * as context. Scoring: literal recall + token-F1 in-runner; run judge-llm.ts
 * afterwards for LLM-judge.
 *
 * Models resolved from a pi-style models.json (same as run-mem0.ts).
 *
 * Usage:
 *   pnpm --filter @amaster.ai/pi-eval eval:memory:curated -- \
 *     --samples 2 --concurrency 2 \
 *     --models /Users/weaxs/Desktop/Workspace/pi-agent/.pi/models.json
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '@amaster.ai/pi-memory/store';
import type { LocomoSample } from '../src/loaders/locomo.js';
import { loadLocomo } from '../src/loaders/locomo.js';
import { tokenF1 } from '../src/judge.js';

interface Args {
  samples: number;
  concurrency: number;
  modelsPath: string;
  provider: string;
  model: string;
  maxSessions: number;
  maxQa: number;
}

interface ModelsJson {
  providers: Record<string, { apiKey: string; baseUrl?: string }>;
}

interface ProviderInfo {
  apiKey: string;
  baseUrl: string;
}

interface Row {
  sample: string;
  question: string;
  gold: string;
  recall: number;
  f1: number;
  blob: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  return {
    samples: Number(get('--samples', '2')),
    concurrency: Number(get('--concurrency', '2')),
    modelsPath:
      get('--models', '') ||
      process.env.PI_MODELS_PATH ||
      path.join(os.homedir(), '.pi', 'agent', 'models.json'),
    provider: get('--provider', 'amaster'),
    model: get('--model', 'deepseek-v4-flash'),
    maxSessions: Number(get('--max-sessions', '0')),
    maxQa: Number(get('--max-qa', '0')),
  };
}

async function loadProvider(args: Args): Promise<ProviderInfo> {
  const raw = await readFile(args.modelsPath, 'utf8');
  const models = JSON.parse(raw) as ModelsJson;
  const entry = models.providers?.[args.provider];
  if (!entry?.apiKey || !entry?.baseUrl) {
    throw new Error(`provider ${args.provider} missing apiKey/baseUrl in ${args.modelsPath}`);
  }
  return { apiKey: entry.apiKey, baseUrl: entry.baseUrl };
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  return /\b(5\d\d|429|overloaded|timeout|timed out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|getaddrinfo|fetch failed|socket|Connection error|APIConnection)\b/i.test(
    `${msg}\n${cause}`,
  );
}

async function chat(
  cfg: ProviderInfo,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<string> {
  const delays = [1000, 4000, 16000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length || !isTransient(err)) break;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// Write loop
// ---------------------------------------------------------------------------

interface MemoryOp {
  op: 'add' | 'replace' | 'remove';
  target: 'memory' | 'user';
  content?: string;
  oldText?: string;
  newContent?: string;
}

const WRITE_SYSTEM = `You are the memory manager for an AI assistant. You maintain two persistent stores under strict character budgets:
- MEMORY (your own notes): 2200 chars max
- USER (facts about the user): 1375 chars max

You are shown one conversation session and the current contents of both stores. Decide what durable facts to persist. Prefer user preferences, personal details, stable facts, decisions, and events with dates. Skip small talk and transient state.

Because the budget is tight, consolidate: prefer replacing/merging an existing entry over adding a near-duplicate, and remove stale entries when superseded.

Respond with ONLY a JSON array of operations, no prose. Each op is one of:
{"op":"add","target":"memory|user","content":"..."}
{"op":"replace","target":"memory|user","oldText":"<unique substring of an existing entry>","newContent":"..."}
{"op":"remove","target":"memory|user","oldText":"<unique substring of an existing entry>"}
Return [] if nothing is worth persisting from this session.`;

function extractJsonArray(text: string): MemoryOp[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as MemoryOp[]) : [];
  } catch {
    return [];
  }
}

function snapshot(store: MemoryStore): string {
  const mem = store.getEntries('memory');
  const usr = store.getEntries('user');
  return [
    `MEMORY (${mem.join('\n§\n').length}/2200 chars):`,
    mem.length ? mem.map((e, i) => `[M${i}] ${e}`).join('\n') : '(empty)',
    '',
    `USER (${usr.join('\n§\n').length}/1375 chars):`,
    usr.length ? usr.map((e, i) => `[U${i}] ${e}`).join('\n') : '(empty)',
  ].join('\n');
}

async function applyOp(store: MemoryStore, op: MemoryOp): Promise<void> {
  const target = op.target === 'user' ? 'user' : 'memory';
  if (op.op === 'add' && op.content) {
    await store.add(target, op.content);
  } else if (op.op === 'replace' && op.oldText && op.newContent) {
    await store.replace(target, op.oldText, op.newContent);
  } else if (op.op === 'remove' && op.oldText) {
    await store.remove(target, op.oldText);
  }
  // Errors (over-limit, no match, threat) are left to the model's next-session
  // view: the snapshot reflects actual stored state, so it self-corrects.
}

function sessionTurns(sample: LocomoSample): Map<number, string[]> {
  const bySession = new Map<number, string[]>();
  for (const t of sample.turns) {
    if (!t.text) continue;
    const line = `${t.speaker}: ${t.text}`;
    const list = bySession.get(t.session);
    if (list) list.push(line);
    else bySession.set(t.session, [line]);
  }
  return bySession;
}

async function runSample(cfg: ProviderInfo, args: Args, s: LocomoSample): Promise<Row[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-memory-eval-'));
  const store = new MemoryStore({ dir });
  const rows: Row[] = [];
  try {
    await store.loadFromDisk();
    const sessions = [...sessionTurns(s).entries()].sort((a, b) => a[0] - b[0]);
    const limited = args.maxSessions > 0 ? sessions.slice(0, args.maxSessions) : sessions;
    process.stderr.write(
      `[eval:curated] write ${s.sampleId}: ${limited.length}/${sessions.length} sessions\n`,
    );
    let si = 0;
    for (const [sessionId, turns] of limited) {
      const userPrompt = [
        `## Current memory state`,
        snapshot(store),
        '',
        `## Conversation session ${sessionId}`,
        turns.join('\n'),
      ].join('\n');
      const reply = await chat(
        cfg,
        args.model,
        [
          { role: 'system', content: WRITE_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        4096,
      );
      const ops = extractJsonArray(reply);
      for (const op of ops) await applyOp(store, op);
      si++;
      process.stderr.write(
        `[eval:curated]   ${s.sampleId} session ${si}/${limited.length} (${ops.length} ops)\n`,
      );
    }

    const blob = [...store.getEntries('memory'), ...store.getEntries('user')].join('\n');
    const qa = args.maxQa > 0 ? s.qa.slice(0, args.maxQa) : s.qa;
    // Score against the full curated memory snapshot — same semantics as the
    // mem0 runner (does the retained memory contain the answer?), so the two
    // are comparable under the same judge. pi-memory has no retrieval step;
    // the whole snapshot IS what the agent sees, so we score the whole thing.
    process.stderr.write(`[eval:curated] score ${s.sampleId}: ${qa.length} QA\n`);
    for (const q of qa) {
      const recall = blob.toLowerCase().includes(q.answer.toLowerCase()) ? 1 : 0;
      const f1 = tokenF1(blob, q.answer).score;
      rows.push({ sample: s.sampleId, question: q.question, gold: q.answer, recall, f1, blob });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return rows;
}

async function main() {
  const args = parseArgs();
  const cfg = await loadProvider(args);
  const samples = (await loadLocomo()).slice(0, args.samples);
  process.stderr.write(
    `[eval:curated] samples=${samples.length} concurrency=${args.concurrency} model=${args.provider}/${args.model}\n`,
  );

  const rows: Row[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= samples.length) return;
      try {
        rows.push(...(await runSample(cfg, args, samples[idx])));
      } catch (err) {
        process.stderr.write(
          `[eval:curated] sample ${samples[idx].sampleId} failed: ${(err as Error).message}\n`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(args.concurrency, samples.length)) }, worker),
  );

  const avg = (k: 'recall' | 'f1') => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
  const summary = { n: rows.length, recall: avg('recall'), tokenF1: avg('f1') };
  process.stderr.write(`[eval:curated] ${JSON.stringify(summary)}\n`);

  const outDir = path.resolve(import.meta.dirname, '..', 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'memory-locomo.json'),
    JSON.stringify({ summary, rows }, null, 2),
  );
}

main().catch((err) => {
  process.stderr.write(`[eval:curated] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
