/**
 * LoCoMo loader. Real schema (verified against locomo10.json):
 *
 *   top-level: array of samples
 *   sample = {
 *     sample_id: string,
 *     conversation: {
 *       speaker_a: string,
 *       speaker_b: string,
 *       session_N: Turn[],
 *       session_N_date_time: string,
 *     },
 *     qa: { question: string, answer: string, evidence: string[], category: number }[],
 *     event_summary, observation, session_summary — unused for now
 *   }
 *   Turn = { speaker: string, dia_id: string, text: string, ... }
 *
 * Upstream: https://github.com/snap-research/locomo (MIT)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface LocomoTurn {
  speaker: string;
  text: string;
  diaId: string;
  session: number;
  timestamp?: string;
}

export interface LocomoQA {
  question: string;
  answer: string;
  category?: number;
  evidence?: string[];
}

export interface LocomoSample {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  turns: LocomoTurn[];
  qa: LocomoQA[];
}

const DATASETS_DIR = path.resolve(import.meta.dirname, '..', '..', 'datasets', 'locomo');

export async function loadLocomo(file = 'locomo10.json'): Promise<LocomoSample[]> {
  const raw = await readFile(path.join(DATASETS_DIR, file), 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('[locomo] top-level not an array');
  return data.map(adaptSample);
}

function parseLocomoTimestamp(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // LoCoMo format is "H:MM am/pm on D Month, YYYY", e.g. "1:56 pm on 8 May, 2023".
  // Native `new Date()` returns Invalid on this — extract the date part manually.
  const m = /on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i.exec(raw);
  if (!m) return raw;
  const [, day, monthName, year] = m;
  const monthIdx: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const mi = monthIdx[monthName.toLowerCase()];
  if (mi === undefined) return raw;
  const d = new Date(Date.UTC(Number(year), mi, Number(day)));
  return d.toISOString().slice(0, 10);
}

function adaptSample(s: unknown): LocomoSample {
  const obj = s as Record<string, unknown>;
  const conv = (obj.conversation ?? {}) as Record<string, unknown>;
  const turns: LocomoTurn[] = [];
  for (const key of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(key);
    if (!m) continue;
    const session = Number(m[1]);
    const rawTs = conv[`session_${session}_date_time`] as string | undefined;
    const timestamp = parseLocomoTimestamp(rawTs);
    const arr = conv[key];
    if (!Array.isArray(arr)) continue;
    for (const t of arr as Array<Record<string, unknown>>) {
      turns.push({
        speaker: String(t.speaker ?? ''),
        text: String(t.text ?? ''),
        diaId: String(t.dia_id ?? ''),
        session,
        timestamp,
      });
    }
  }
  turns.sort((a, b) => a.session - b.session); // ponytail: stable enough; dia_id ordering handled by file order
  const qa: LocomoQA[] = ((obj.qa ?? []) as Array<Record<string, unknown>>).map((q) => ({
    question: String(q.question ?? ''),
    answer: String(q.answer ?? ''),
    category: typeof q.category === 'number' ? q.category : undefined,
    evidence: Array.isArray(q.evidence) ? (q.evidence as string[]) : undefined,
  }));
  return {
    sampleId: String(obj.sample_id ?? ''),
    speakerA: String(conv.speaker_a ?? ''),
    speakerB: String(conv.speaker_b ?? ''),
    turns,
    qa,
  };
}
