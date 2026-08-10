/**
 * ViMax-Bench loader. Real schema (verified against vimax_benchmark/*.json @ 05a4894):
 *
 *   benchmark_index.json: { total_stories, stories: [{ id, type, theme, file }] }
 *   story file = {
 *     story_overview: string,
 *     consistency_type: "Type A" | "Type B" | "Type C",
 *     metadata: { theme_key, theme_description, requested_scenes, requested_shots },
 *     scenes: [{ scene_num, shots: [{ shot_id, first_frame, video_prompt }] }],
 *   }
 *
 * Types (per the paper, arXiv 2606.07649):
 *   A = character persistence, B = background persistence, C = multi-person interaction.
 * Tier is derived, not stored upstream: Medium = ≤2 scenes (8–10 shots), Long = 3–4.
 *
 * Upstream: https://github.com/HKUDS/ViMax (MIT); pulled by scripts/fetch-vimax.ts.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type VimaxType = 'A' | 'B' | 'C';
export type VimaxTier = 'medium' | 'long';

export interface VimaxShot {
  shotId: string;
  sceneNum: number;
  firstFrame: string;
  videoPrompt: string;
}

export interface VimaxStory {
  id: string;
  type: VimaxType;
  tier: VimaxTier;
  theme: string;
  overview: string;
  shots: VimaxShot[];
}

const DATASETS_DIR = path.resolve(import.meta.dirname, '..', '..', 'datasets', 'vimax');

/** Job ids and shot ids become directory names — strip anything but safe chars. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function adaptStory(id: string, raw: unknown): VimaxStory {
  const obj = raw as Record<string, unknown>;
  const typeMatch = /Type\s*([ABC])/i.exec(String(obj.consistency_type ?? ''));
  if (!typeMatch) throw new Error(`[vimax] ${id}: unparseable consistency_type`);
  const scenes = (Array.isArray(obj.scenes) ? obj.scenes : []) as Array<Record<string, unknown>>;
  const shots: VimaxShot[] = [];
  for (const scene of scenes) {
    const sceneNum = Number(scene.scene_num ?? 0);
    const rawShots = (Array.isArray(scene.shots) ? scene.shots : []) as Array<
      Record<string, unknown>
    >;
    for (const shot of rawShots) {
      shots.push({
        shotId: slug(String(shot.shot_id ?? `s${shots.length + 1}`)),
        sceneNum,
        firstFrame: String(shot.first_frame ?? ''),
        videoPrompt: String(shot.video_prompt ?? ''),
      });
    }
  }
  if (shots.length === 0) throw new Error(`[vimax] ${id}: no shots`);
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  return {
    id: slug(id),
    type: typeMatch[1]!.toUpperCase() as VimaxType,
    tier: scenes.length <= 2 ? 'medium' : 'long',
    theme: String(meta.theme_description ?? meta.theme_key ?? id),
    overview: String(obj.story_overview ?? ''),
    shots,
  };
}

/**
 * Load all fetched stories. benchmark_index.json is skipped (metadata only);
 * every other *.json in datasets/vimax/ is one story.
 */
export async function loadVimax(): Promise<VimaxStory[]> {
  const files = (await readdir(DATASETS_DIR))
    .filter((f) => f.endsWith('.json') && f !== 'benchmark_index.json')
    .sort();
  if (files.length === 0) {
    throw new Error('[vimax] no story files — run `pnpm --filter @amaster.ai/pi-eval fetch:vimax`');
  }
  const stories: VimaxStory[] = [];
  for (const f of files) {
    const raw = JSON.parse(await readFile(path.join(DATASETS_DIR, f), 'utf8'));
    stories.push(adaptStory(path.basename(f, '.json'), raw));
  }
  return stories;
}
