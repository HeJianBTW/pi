#!/usr/bin/env node
/**
 * Run pi-memory-mem0 against LoCoMo. Per sample:
 *   1. Ingest each turn via Mem0Provider.add()
 *   2. For each QA, search(query) → score recall@k + token-F1
 *
 * Modes:
 *   --mode platform   uses Mem0 cloud (MEM0_API_KEY)
 *   --mode oss        local in-memory vector store; embedding + extraction
 *                     LLM resolved from a pi-style models.json (default:
 *                     ~/.pi/agent/models.json, override via --models <path>
 *                     or env PI_MODELS_PATH)
 *
 * Recall = "did the gold answer literally appear in any topK result."
 * The answering LLM is NOT wired — separate harness layer.
 *
 * Usage:
 *   pnpm --filter @amaster.ai/pi-eval eval:memory:mem0 -- \
 *     --mode oss --samples 2 --topk 5 \
 *     --llm-provider amaster --llm-model deepseek-v4-pro \
 *     --embed-provider amaster --embed-model text-embedding-v4 \
 *     --models /Users/weaxs/Desktop/Workspace/pi-agent/.pi/models.json
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMem0Provider } from '@amaster.ai/pi-memory-mem0/provider';
import { loadLocomo } from '../src/loaders/locomo.js';
import { tokenF1 } from '../src/judge.js';

// Re-declare structurally — mem0 root package doesn't re-export these types.
type Mem0Mode = 'platform' | 'open-source';
interface Mem0Config {
  mode?: Mem0Mode;
  apiKey?: string;
  topK?: number;
  useRegistryKeys?: boolean;
  oss?: {
    disableHistory?: boolean;
    embedder?: { provider: string; config?: Record<string, unknown> };
    llm?: { provider: string; config?: Record<string, unknown> };
    vectorStore?: { provider: string; config?: Record<string, unknown> };
  };
}
interface Hit {
  memory?: string;
}
interface ProviderInfo {
  apiKey: string;
  baseUrl?: string;
  api?: string;
}
interface ModelsJson {
  providers: Record<string, { apiKey: string; baseUrl?: string; api?: string }>;
}

interface Args {
  mode: 'platform' | 'oss';
  samples: number;
  topk: number;
  modelsPath: string;
  llmProvider: string;
  llmModel: string;
  embedProvider: string;
  embedModel: string;
  embedDims: number;
  maxTurns: number;
  maxQa: number;
  concurrency: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const mode = get('--mode', 'oss');
  if (mode !== 'platform' && mode !== 'oss') {
    throw new Error(`--mode must be platform|oss, got: ${mode}`);
  }
  return {
    mode,
    samples: Number(get('--samples', '2')),
    topk: Number(get('--topk', '5')),
    modelsPath:
      get('--models', '') ||
      process.env.PI_MODELS_PATH ||
      path.join(os.homedir(), '.pi', 'agent', 'models.json'),
    llmProvider: get('--llm-provider', 'amaster'),
    llmModel: get('--llm-model', 'deepseek-v4-flash'),
    embedProvider: get('--embed-provider', 'amaster'),
    embedModel: get('--embed-model', 'text-embedding-v4'),
    embedDims: Number(get('--embed-dims', '1024')),
    maxTurns: Number(get('--max-turns', '0')),
    maxQa: Number(get('--max-qa', '0')),
    concurrency: Number(get('--concurrency', '2')),
  };
}

async function loadModelsJson(file: string): Promise<ModelsJson> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as ModelsJson;
  } catch (err) {
    throw new Error(`failed to read models.json at ${file}: ${(err as Error).message}`);
  }
}

function buildResolver(models: ModelsJson) {
  return async (providerName: string): Promise<ProviderInfo | undefined> => {
    const entry = models.providers?.[providerName];
    if (!entry || !entry.apiKey) return undefined;
    return { apiKey: entry.apiKey, baseUrl: entry.baseUrl, api: entry.api };
  };
}

/**
 * Retry transient failures (5xx, throttle, ECONN/ETIMEDOUT). Business errors
 * — bad request, auth — surface immediately.
 *
 * ponytail: 3 tries, 1s/4s/16s. amaster throttle window is in seconds, not minutes.
 */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const haystack = `${msg}\n${cause}`;
  return /\b(5\d\d|429|overloaded|timeout|timed out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|getaddrinfo|fetch failed|socket|Connection error|APIConnection)\b/i.test(
    haystack,
  );
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 4000, 16000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const last = attempt === delays.length;
      if (last || !isTransient(err)) throw err;
      const wait = delays[attempt];
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[eval:mem0] retry ${label} in ${wait}ms (${msg.slice(0, 120)})\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}


function buildConfig(args: Args): Mem0Config {
  if (args.mode === 'platform') {
    const apiKey = process.env.MEM0_API_KEY;
    if (!apiKey) throw new Error('MEM0_API_KEY required for --mode platform');
    return { mode: 'platform', apiKey, topK: args.topk };
  }
  return {
    mode: 'open-source',
    topK: args.topk,
    useRegistryKeys: true,
    oss: {
      disableHistory: true, // avoid better-sqlite3 ABI surprises
      // Fresh snapshot path per invocation — otherwise prior runs' facts
      // pollute today's blob. The default path is ~/.pi/agent/memories/mem0-snapshot.db.
      snapshotDbPath: path.join(
        os.tmpdir(),
        `pi-eval-mem0-snapshot-${process.pid}.db`,
      ),
      llm: {
        provider: args.llmProvider,
        config: {
          model: args.llmModel,
          // mem0 OSS OpenAILLM only forwards {messages, model, response_format, tools}
          // to the OpenAI SDK — temperature / reasoning_effort / thinking are
          // ALL silently dropped. Kept here for the day mem0 fixes that, and
          // for any downstream compat that reads config verbatim.
          temperature: 0,
          reasoning_effort: 'high',
        },
      },
      embedder: {
        provider: args.embedProvider,
        config: { model: args.embedModel, embeddingDims: args.embedDims },
      },
      vectorStore: {
        provider: 'memory',
        // mem0's 'memory' vector store is SQLite-backed at ~/.mem0/vector_store.db
        // by default — NOT in-process. Without an explicit per-run dbPath, every
        // eval run accumulates into the same file and pollutes future blobs.
        config: {
          collectionName: 'pi_mem0_eval',
          dimension: args.embedDims,
          dbPath: path.join(os.tmpdir(), `pi-eval-mem0-vs-${process.pid}.db`),
        },
      },
    },
  };
}

interface Row {
  sample: string;
  question: string;
  gold: string;
  recall: number;
  f1: number;
  blob: string;
}

async function runSample(
  provider: Awaited<ReturnType<typeof createMem0Provider>>,
  s: Awaited<ReturnType<typeof loadLocomo>>[number],
  args: Args,
): Promise<Row[]> {
  const rows: Row[] = [];
  const userId = `locomo-${s.sampleId}`;
  const turns = args.maxTurns > 0 ? s.turns.slice(0, args.maxTurns) : s.turns;
  const qa = args.maxQa > 0 ? s.qa.slice(0, args.maxQa) : s.qa;
  process.stderr.write(
    `[eval:mem0] ingest ${s.sampleId}: ${turns.length}/${s.turns.length} turns\n`,
  );
  let i = 0;
  for (const t of turns) {
    if (!t.text) continue;
    const role = t.speaker === s.speakerB ? 'assistant' : 'user';
    const t0 = Date.now();
    await withRetry(`add ${s.sampleId} #${i + 1}`, () =>
      provider.add(
        [{ role, content: `${t.speaker}: ${t.text}` }],
        { userId, observedAt: t.timestamp },
      ),
    );
    i++;
    if (i % 5 === 0 || i === turns.length) {
      process.stderr.write(
        `[eval:mem0]   ${s.sampleId} turn ${i}/${turns.length} (+${Date.now() - t0}ms)\n`,
      );
    }
  }
  process.stderr.write(`[eval:mem0] query ${s.sampleId}: ${qa.length}/${s.qa.length} QA\n`);
  let qi = 0;
  for (const q of qa) {
    const hits: Hit[] = await withRetry(`search ${s.sampleId}`, () =>
      provider.search(q.question, { userId, topK: args.topk }),
    );
    const blob = hits.map((h) => h.memory).filter(Boolean).join('\n');
    const recall = blob.toLowerCase().includes(q.answer.toLowerCase()) ? 1 : 0;
    const f1 = tokenF1(blob, q.answer).score;
    rows.push({ sample: s.sampleId, question: q.question, gold: q.answer, recall, f1, blob });
    qi++;
    if (qi % 20 === 0 || qi === qa.length) {
      process.stderr.write(`[eval:mem0]   ${s.sampleId} qa ${qi}/${qa.length}\n`);
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs();
  const samples = (await loadLocomo()).slice(0, args.samples);
  process.stderr.write(
    `[eval:mem0] mode=${args.mode} samples=${samples.length} concurrency=${args.concurrency}\n`,
  );

  let resolveProvider: ((p: string) => Promise<ProviderInfo | undefined>) | undefined;
  if (args.mode === 'oss') {
    const models = await loadModelsJson(args.modelsPath);
    resolveProvider = buildResolver(models);
    process.stderr.write(
      `[eval:mem0] models=${args.modelsPath} llm=${args.llmProvider}/${args.llmModel} embed=${args.embedProvider}/${args.embedModel}\n`,
    );
  }

  const provider = await createMem0Provider({
    config: buildConfig(args),
    resolveProvider,
  });

  // Simple worker pool over samples. Each sample has an independent userId,
  // so mem0 add/search calls don't collide.
  // ponytail: no rate-limiter beyond concurrency. If amaster starts 429ing
  // the retry helper handles it; drop --concurrency if it's chronic.
  const rows: Row[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= samples.length) return;
      try {
        const got = await runSample(provider, samples[idx], args);
        rows.push(...got);
      } catch (err) {
        process.stderr.write(
          `[eval:mem0] sample ${samples[idx].sampleId} failed: ${(err as Error).message}\n`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(args.concurrency, samples.length)) }, worker),
  );

  const avg = (k: 'recall' | 'f1') =>
    rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
  const summary = { mode: args.mode, n: rows.length, recall: avg('recall'), tokenF1: avg('f1') };
  process.stderr.write(`[eval:mem0] ${JSON.stringify(summary)}\n`);

  const outDir = path.resolve(import.meta.dirname, '..', 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, `mem0-locomo-${args.mode}.json`),
    JSON.stringify({ summary, rows }, null, 2),
  );
}

main().catch((err) => {
  process.stderr.write(`[eval:mem0] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
