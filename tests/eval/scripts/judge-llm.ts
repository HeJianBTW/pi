#!/usr/bin/env node
/**
 * LLM-judge a results/*.json file. For each row, ask deepseek-v4-flash whether
 * the retrieved blob contains enough information to answer the question given
 * the gold answer. Writes results/*-judged.json with per-row `judge: 0|1` and a
 * new `recallJudge` summary metric.
 *
 * Usage:
 *   pnpm --filter @amaster.ai/pi-eval judge:llm -- \
 *     --input results/mem0-locomo-oss.json \
 *     --models /Users/weaxs/Desktop/Workspace/pi-agent/.pi/models.json \
 *     --concurrency 4
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  chatCompletion,
  getFlag,
  type JudgeConfig,
  loadJudgeConfig,
  runPool,
} from '../src/judge-client.js';

interface Args {
  input: string;
  modelsPath: string;
  llmProvider: string;
  llmModel: string;
  concurrency: number;
  limit: number;
}

interface Row {
  sample: string;
  question: string;
  gold: string;
  recall: number;
  f1: number;
  blob?: string;
  judge?: number;
  judgeError?: string;
}

interface Bundle {
  summary: Record<string, unknown>;
  rows: Row[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    input: getFlag(argv, '--input', 'results/mem0-locomo-oss.json'),
    modelsPath:
      getFlag(argv, '--models', '') ||
      process.env.PI_MODELS_PATH ||
      path.join(os.homedir(), '.pi', 'agent', 'models.json'),
    llmProvider: getFlag(argv, '--llm-provider', 'amaster'),
    llmModel: getFlag(argv, '--llm-model', 'deepseek-v4-flash'),
    concurrency: Number(getFlag(argv, '--concurrency', '4')),
    limit: Number(getFlag(argv, '--limit', '0')),
  };
}

const JUDGE_SYSTEM = `You judge whether retrieved memory contains enough information to correctly answer a question, using the gold answer as ground truth.

Rules:
- Answer STRICTLY with the single word: YES or NO.
- YES if the memory contains the gold answer or an equivalent restatement (different wording, dates in different formats, aliases, etc.).
- YES if the memory contains the specific fact needed even without the exact literal string.
- NO if the memory is silent on the fact, gives a wrong value, or is irrelevant.
- NO if the memory only contains a related but insufficient fact.
Do not explain. Do not output anything else. Just YES or NO.`;

function buildUserPrompt(question: string, gold: string, blob: string): string {
  return [
    `Question: ${question}`,
    `Gold answer: ${gold}`,
    '',
    'Retrieved memory:',
    blob.trim() || '(empty)',
  ].join('\n');
}

async function callJudge(cfg: JudgeConfig, prompt: string): Promise<'YES' | 'NO'> {
  // deepseek-v4-flash is a reasoning model — reasoning_tokens eat the budget
  // before content is emitted. 512 gives it enough headroom.
  const text = (
    await chatCompletion(cfg, {
      maxTokens: 512,
      temperature: 0,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
    })
  )
    .trim()
    .toUpperCase();
  // Reasoning models sometimes prepend their scratchpad. Find the last clear
  // YES / NO signal in the response.
  const yesIdx = text.lastIndexOf('YES');
  const noIdx = text.lastIndexOf('NO');
  if (yesIdx < 0 && noIdx < 0) {
    throw new Error(`unexpected judge reply: ${text.slice(-120)}`);
  }
  return yesIdx > noIdx ? 'YES' : 'NO';
}

async function main() {
  const args = parseArgs();
  const raw = await readFile(args.input, 'utf8');
  const bundle = JSON.parse(raw) as Bundle;

  const rows = args.limit > 0 ? bundle.rows.slice(0, args.limit) : bundle.rows;
  process.stderr.write(`[judge:llm] input=${args.input} rows=${rows.length}\n`);

  const missing = rows.filter((r) => !r.blob).length;
  if (missing > 0) {
    throw new Error(
      `${missing}/${rows.length} rows have no blob — rerun eval with the current run-mem0.ts (which stores blob) before judging.`,
    );
  }

  const cfg = loadJudgeConfig(args.modelsPath, args.llmProvider, args.llmModel);
  process.stderr.write(`[judge:llm] model=${cfg.model} concurrency=${args.concurrency}\n`);

  let done = 0;
  await runPool(rows, args.concurrency, async (r) => {
    try {
      const verdict = await callJudge(cfg, buildUserPrompt(r.question, r.gold, r.blob!));
      r.judge = verdict === 'YES' ? 1 : 0;
    } catch (err) {
      r.judge = 0;
      r.judgeError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
    done++;
    if (done % 20 === 0 || done === rows.length) {
      process.stderr.write(`[judge:llm]   ${done}/${rows.length}\n`);
    }
  });

  const judged = rows.filter((r) => r.judgeError === undefined);
  const recallJudge = judged.reduce((a, r) => a + (r.judge ?? 0), 0) / Math.max(1, judged.length);
  const errors = rows.length - judged.length;
  const oldSummary = bundle.summary;
  const newSummary = { ...oldSummary, recallJudge, judgeN: judged.length, judgeErrors: errors };

  process.stderr.write(`[judge:llm] recallJudge=${recallJudge.toFixed(4)} errors=${errors}\n`);

  const outDir = path.resolve(path.dirname(args.input));
  const inBase = path.basename(args.input, '.json');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, `${inBase}-judged.json`),
    JSON.stringify({ summary: newSummary, rows }, null, 2),
  );
}

main().catch((err) => {
  process.stderr.write(`[judge:llm] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
