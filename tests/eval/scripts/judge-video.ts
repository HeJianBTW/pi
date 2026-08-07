#!/usr/bin/env node
/**
 * VLM-judge a results/video-vimax.json run: for each completed story, extract one
 * mid-clip frame per shot and ask a vision model to score cross-shot consistency
 * (rubric keyed to the story's ViMax type) plus per-shot prompt following.
 * Writes results/video-vimax-judged.json.
 *
 * This reimplements the SPIRIT of ViMax-Bench's automatic consistency scoring
 * (arXiv 2606.07649) with a VLM judge instead of ViCLIP embeddings — scores are
 * for cross-provider comparison and self-regression, NOT comparable to the paper.
 *
 * Requires ffmpeg+ffprobe (FFMPEG_PATH/FFPROBE_PATH env or on PATH) and a
 * vision-capable --llm-model.
 *
 * Usage:
 *   pnpm --filter @amaster.ai/pi-eval judge:video -- \
 *     --input results/video-vimax.json --llm-model kimi-k2.6 --models /path/to/models.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chatCompletion,
  getFlag,
  type JudgeConfig,
  loadJudgeConfig,
  runPool,
} from '../src/judge-client.js';
import { loadVimax, type VimaxStory, type VimaxType } from '../src/loaders/vimax.js';

interface Args {
  input: string;
  modelsPath: string;
  llmProvider: string;
  llmModel: string;
  concurrency: number;
  limit: number;
}

interface ResultRow {
  story: string;
  type: VimaxType;
  tier: string;
  shots: number;
  completed: number;
  finalVideoPath: string;
}

interface Bundle {
  summary: Record<string, unknown>;
  rows: ResultRow[];
}

interface ShotScore {
  shot_id: string;
  prompt_following: number;
}

interface StoryScore {
  story: string;
  type: VimaxType;
  tier: string;
  consistency?: number;
  promptFollowing?: number;
  perShot?: ShotScore[];
  notes?: string;
  judgeError?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    input: getFlag(argv, '--input', 'results/video-vimax.json'),
    modelsPath:
      getFlag(argv, '--models', '') ||
      process.env.PI_MODELS_PATH ||
      path.join(os.homedir(), '.pi', 'agent', 'models.json'),
    llmProvider: getFlag(argv, '--llm-provider', 'amaster'),
    llmModel: getFlag(argv, '--llm-model', 'kimi-k2.6'),
    concurrency: Number(getFlag(argv, '--concurrency', '2')),
    limit: Number(getFlag(argv, '--limit', '0')),
  };
}

const TYPE_RUBRIC: Record<VimaxType, string> = {
  A: 'CHARACTER PERSISTENCE — the same character keeps identity (face, hair, outfit, body) across every shot despite changing environment, lighting, and camera. 5 = identity indistinguishable throughout; 3 = same person but drifting details; 1 = a different person per shot.',
  B: 'BACKGROUND PERSISTENCE — within the same scene, the space stays stable (geometry, layout, furniture, props). 5 = identical space across cuts; 3 = same room, rearranged details; 1 = unrelated rooms between shots of one scene.',
  C: 'MULTI-PERSON SEPARABILITY — multiple visually distinct characters stay separable while interacting: no merging, no identity swaps, no attribute bleed. 5 = every character keeps their own identity throughout; 1 = characters merge or swap.',
};

function buildSystem(type: VimaxType): string {
  return `You judge an AI-generated multi-shot video story for visual consistency. You see one mid-clip frame per shot, in story order, each labeled with the motion prompt it was generated from.

Score:
1. "consistency" (1-5, integer) — ${TYPE_RUBRIC[type]}
2. "prompt_following" (1-5, integer) PER SHOT — does the frame match what the shot asked for (subject, composition, action)?

Reply with STRICT JSON only, no prose:
{"consistency": <1-5>, "per_shot": [{"shot_id": "<id>", "prompt_following": <1-5>}...], "notes": "<=200 chars"}`;
}

const FRAMES_ROOT = path.resolve(import.meta.dirname, '..', 'results', 'artifacts', 'frames');

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function ffprobeBin(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

/** Clip duration in seconds, 0 when unknown (ffprobe missing/unparseable). */
let ffprobeWarned = false;
function probeDuration(clipPath: string): number {
  const r = spawnSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath],
    { stdio: 'pipe', timeout: 30_000 },
  );
  const d = Number.parseFloat(String(r.stdout).trim());
  const ok = Number.isFinite(d) && d > 0;
  if (!ok && !ffprobeWarned) {
    ffprobeWarned = true;
    process.stderr.write('[judge:video] ffprobe unavailable/unparseable — judging fixed 2s seeks, not true mid-clip\n');
  }
  return ok ? d : 0;
}

/**
 * True mid-clip frame (probed duration / 2), downscaled to keep the judge
 * request small. Falls back to ~2s, then the first frame, for unprobed or
 * short clips.
 */
function extractFrame(clipPath: string, outPath: string): void {
  const base = ['-y', '-i', clipPath, '-frames:v', '1', '-vf', 'scale=512:-1', '-q:v', '4', outPath];
  const duration = probeDuration(clipPath);
  const seeks = duration > 0 ? [duration / 2, 2] : [2];
  for (const ss of seeks) {
    // timeout: a hung ffmpeg on a corrupt clip must not park a judge worker.
    const r = spawnSync(ffmpegBin(), ['-ss', ss.toFixed(2), ...base], { stdio: 'pipe', timeout: 60_000 });
    if (r.status === 0 && existsSync(outPath)) return;
  }
  const r = spawnSync(ffmpegBin(), base, { stdio: 'pipe', timeout: 60_000 });
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new Error(`ffmpeg produced no frame for ${clipPath}`);
  }
}

interface JudgeReply {
  consistency: number;
  per_shot: ShotScore[];
  notes?: string;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

async function callJudge(
  cfg: JudgeConfig,
  system: string,
  content: ContentPart[],
): Promise<JudgeReply> {
  const text = await chatCompletion(cfg, {
    maxTokens: 2048,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  });
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) throw new Error(`no JSON in judge reply: ${text.slice(-120)}`);
  const parsed = JSON.parse(jsonMatch[0]) as JudgeReply;
  if (typeof parsed.consistency !== 'number' || !Array.isArray(parsed.per_shot)) {
    throw new Error(`malformed judge reply: ${text.slice(-120)}`);
  }
  return parsed;
}

async function judgeStory(
  cfg: JudgeConfig,
  story: VimaxStory,
  jobDir: string,
): Promise<Omit<StoryScore, 'story' | 'type' | 'tier'>> {
  const framesDir = path.join(FRAMES_ROOT, story.id);
  await mkdir(framesDir, { recursive: true });
  // ponytail: one message holds all shots of a story (≤16 images) — if a VLM
  // rejects the payload, chunk by scene and average.
  const content: ContentPart[] = [
    { type: 'text', text: `Story: ${story.overview}\n\nFrames follow, one per shot, in story order.` },
  ];
  let frames = 0;
  let firstExtractErr: unknown;
  let skipped = 0;
  for (const shot of story.shots) {
    const clipPath = path.join(jobDir, 'shots', shot.shotId, 'video.mp4');
    const framePath = path.join(framesDir, `${shot.shotId}.jpg`);
    try {
      extractFrame(clipPath, framePath);
    } catch (err) {
      firstExtractErr ??= err; // clip missing (shot failed) — judge sees the rest
      skipped++;
      continue;
    }
    const b64 = await readFile(framePath, 'base64');
    content.push({ type: 'text', text: `Shot ${shot.shotId} — motion prompt: ${shot.videoPrompt}` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    frames++;
  }
  if (frames === 0) {
    const cause = firstExtractErr instanceof Error ? firstExtractErr.message : String(firstExtractErr);
    throw new Error(`no extractable frames (first error: ${cause.slice(0, 200)})`);
  }
  if (skipped > 0) {
    process.stderr.write(`[judge:video] ${story.id}: ${skipped} shot(s) had no extractable frame\n`);
  }

  const reply = await callJudge(cfg, buildSystem(story.type), content);
  const pf = reply.per_shot.map((s) => s.prompt_following).filter((n) => typeof n === 'number');
  return {
    consistency: reply.consistency,
    promptFollowing: pf.length ? pf.reduce((a, b) => a + b, 0) / pf.length : undefined,
    perShot: reply.per_shot,
    notes: reply.notes,
  };
}

async function main() {
  const args = parseArgs();
  const bundle = JSON.parse(await readFile(args.input, 'utf8')) as Bundle;
  const stories = new Map((await loadVimax()).map((s) => [s.id, s]));
  const rows = bundle.rows.filter((r) => r.completed === 1 && r.finalVideoPath);
  const selected = args.limit > 0 ? rows.slice(0, args.limit) : rows;
  process.stderr.write(`[judge:video] input=${args.input} completed=${rows.length} judging=${selected.length}\n`);

  const cfg = loadJudgeConfig(args.modelsPath, args.llmProvider, args.llmModel);
  const scores: StoryScore[] = [];
  await runPool(selected, args.concurrency, async (row) => {
    const story = stories.get(row.story);
    const base = { story: row.story, type: row.type, tier: row.tier };
    if (!story) {
      scores.push({ ...base, judgeError: 'story not in datasets/vimax (refetch?)' });
      return;
    }
    try {
      const scored = await judgeStory(cfg, story, path.dirname(row.finalVideoPath));
      scores.push({ ...base, ...scored });
      process.stderr.write(`[judge:video] ${row.story}: consistency=${scored.consistency}\n`);
    } catch (err) {
      scores.push({ ...base, judgeError: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  });
  scores.sort((a, b) => selected.findIndex((r) => r.story === a.story) - selected.findIndex((r) => r.story === b.story));

  const judged = scores.filter((s) => s.judgeError === undefined && s.consistency !== undefined);
  const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);
  const byType: Record<string, { n: number; meanConsistency: number }> = {};
  for (const t of ['A', 'B', 'C'] as const) {
    const ns = judged.filter((s) => s.type === t).map((s) => s.consistency!);
    if (ns.length) byType[t] = { n: ns.length, meanConsistency: mean(ns) };
  }
  const summary = {
    ...bundle.summary,
    llmModel: args.llmModel,
    judged: judged.length,
    judgeErrors: scores.length - judged.length,
    meanConsistency: mean(judged.map((s) => s.consistency!)),
    meanPromptFollowing: mean(judged.flatMap((s) => (s.promptFollowing !== undefined ? [s.promptFollowing] : []))),
    byType,
  };
  process.stderr.write(`[judge:video] ${JSON.stringify(summary)}\n`);

  const out = path.join(path.dirname(args.input), `${path.basename(args.input, '.json')}-judged.json`);
  await writeFile(out, JSON.stringify({ summary, scores }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[judge:video] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
