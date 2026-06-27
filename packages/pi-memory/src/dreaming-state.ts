/**
 * Dreaming state persistence — tracks when the last consolidation ran.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveHome } from '@amaster.ai/pi-shared/settings';

export interface DreamingState {
  lastConsolidatedAt: string | null;
  lastSessionCount: number;
}

const STATE_FILE = 'memories/dreaming-state.json';

function statePath(): string {
  return join(resolveHome(), STATE_FILE);
}

export async function readDreamingState(): Promise<DreamingState> {
  try {
    const raw = await readFile(statePath(), 'utf-8');
    return JSON.parse(raw) as DreamingState;
  } catch {
    return { lastConsolidatedAt: null, lastSessionCount: 0 };
  }
}

export async function writeDreamingState(state: DreamingState): Promise<void> {
  const filePath = statePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}
