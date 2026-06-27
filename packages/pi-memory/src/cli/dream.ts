#!/usr/bin/env node
/**
 * pi-memory-dream CLI — one-shot dreaming execution.
 *
 * Designed to be called by system cron (launchd/crontab/schtasks).
 * Performs gate check, consolidation, and dedup, then exits.
 */
import { join } from 'node:path';
import { dedupMemories } from '@amaster.ai/pi-memory-mem0/dedup';
import { loadPiSettings, resolveHome } from '@amaster.ai/pi-shared/settings';
import { JsonFileTranscriptStore } from '@amaster.ai/pi-storage/json';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { runConsolidation } from '../consolidation.js';
import { readDreamingState, writeDreamingState } from '../dreaming-state.js';

interface DreamingConfig {
  enabled?: boolean;
  intervalHours?: number;
  minHoursSinceLastRun?: number;
  minSessionsSinceLastRun?: number;
  model?: { provider: string; model: string };
}

interface PiMemorySettings {
  dreaming?: DreamingConfig;
}

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_MODEL = { provider: 'openai', model: 'gpt-4.1-mini' };

async function main(): Promise<void> {
  const settings = loadPiSettings<PiMemorySettings>('pi-memory');
  const config = settings.dreaming ?? {};

  if (config.enabled === false) {
    process.exit(0);
  }

  const home = resolveHome();
  const state = await readDreamingState();
  const now = Date.now();
  const minHours = config.minHoursSinceLastRun ?? DEFAULT_MIN_HOURS;
  const minSessions = config.minSessionsSinceLastRun ?? DEFAULT_MIN_SESSIONS;

  // Gate check: enough time since last run?
  if (state.lastConsolidatedAt) {
    const elapsed = now - new Date(state.lastConsolidatedAt).getTime();
    if (elapsed < minHours * 60 * 60 * 1000) {
      process.exit(0);
    }
  }

  // Gate check: enough sessions since last run?
  const transcriptsPath = join(home, 'transcripts.json');
  const transcripts = new JsonFileTranscriptStore(transcriptsPath);
  const turns = await transcripts.listTurns({ tenantId: 'default' });
  const recentTurns = state.lastConsolidatedAt
    ? turns.filter(
        (t) =>
          t.createdAt &&
          new Date(t.createdAt).getTime() > new Date(state.lastConsolidatedAt!).getTime(),
      )
    : turns;

  if (recentTurns.length < minSessions) {
    process.exit(0);
  }

  const abortController = new AbortController();
  process.on('SIGTERM', () => abortController.abort());
  process.on('SIGINT', () => abortController.abort());

  // Phase 1: Consolidation
  const modelConfig = config.model ?? DEFAULT_MODEL;
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  let consolidationSucceeded = false;
  try {
    consolidationSucceeded = await runConsolidation({
      memoryDir: join(home, 'memories'),
      turns: recentTurns,
      modelConfig,
      modelRegistry: {
        find: (p, m) => modelRegistry.find(p, m),
        getApiKeyAndHeaders: (model) => modelRegistry.getApiKeyAndHeaders(model as never),
      },
      signal: abortController.signal,
    });
  } catch {
    // consolidation failure — don't update state so we retry next time
  }

  if (abortController.signal.aborted) process.exit(0);

  // Phase 2: Dedup
  const mem0Settings = loadPiSettings<Record<string, unknown>>('pi-memory-mem0');
  if (mem0Settings && Object.keys(mem0Settings).length > 0) {
    try {
      await dedupMemories({
        userId: (mem0Settings.userId as string) ?? process.env.USER ?? 'default',
        config: mem0Settings as never,
        signal: abortController.signal,
      });
    } catch {
      // dedup failure is non-fatal
    }
  }

  // Only update state if consolidation ran successfully
  if (consolidationSucceeded) {
    await writeDreamingState({
      lastConsolidatedAt: new Date(now).toISOString(),
      lastSessionCount: recentTurns.length,
    });
  }
}

main().catch(() => process.exit(1));
