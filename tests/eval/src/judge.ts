/**
 * Minimal LLM-judge stub. Real implementation wires to whatever provider the
 * dev has configured (OpenAI / Anthropic / pi model registry). For now: token-
 * level F1 + a hook for LLM judging once we pick a provider.
 *
 * ponytail: token-F1 is the floor metric — add LLM-judge when token-F1
 * disagrees with eyeballed quality on >10% of samples.
 */
export interface JudgeResult {
  score: number; // 0..1
  rationale?: string;
}

const PUNCT = /[\p{P}\p{S}]/gu;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(PUNCT, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function tokenF1(prediction: string, gold: string): JudgeResult {
  const p = tokens(prediction);
  const g = tokens(gold);
  if (p.length === 0 && g.length === 0) return { score: 1 };
  if (p.length === 0 || g.length === 0) return { score: 0 };
  const gSet = new Map<string, number>();
  for (const t of g) gSet.set(t, (gSet.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = gSet.get(t);
    if (c && c > 0) {
      overlap++;
      gSet.set(t, c - 1);
    }
  }
  if (overlap === 0) return { score: 0 };
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return { score: (2 * precision * recall) / (precision + recall) };
}
