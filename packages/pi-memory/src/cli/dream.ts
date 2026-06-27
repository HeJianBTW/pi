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
  minTurnsSinceLastRun?: number;
  /** @deprecated Use minTurnsSinceLastRun */
  minSessionsSinceLastRun?: number;
  model?: { provider: string; model: string };
  /** User ID for mem0 dedup. Persisted here so cron doesn't depend on shell env. */
  mem0UserId?: string;
}

interface PiMemorySettings {
  dreaming?: DreamingConfig;
}

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_TURNS = 5;
const DEFAULT_MODEL = { provider: 'openai', model: 'gpt-4.1-mini' };

function log(msg: string): void {
  process.stderr.write(`[pi-memory-dream ${new Date().toISOString()}] ${msg}\n`);
}

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
  const minTurns =
    config.minTurnsSinceLastRun ?? config.minSessionsSinceLastRun ?? DEFAULT_MIN_TURNS;

  // Gate check: enough time since last run?
  if (state.lastConsolidatedAt) {
    const elapsed = now - new Date(state.lastConsolidatedAt).getTime();
    if (elapsed < minHours * 60 * 60 * 1000) {
      process.exit(0);
    }
  }

  // Gate check: enough turns since last run?
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

  if (recentTurns.length < minTurns) {
    process.exit(0);
  }

  log(`starting: ${recentTurns.length} turns since last run`);

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
    if (consolidationSucceeded) log('consolidation done');
    else log('consolidation skipped (model/auth unavailable)');
  } catch (err) {
    log(`consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (abortController.signal.aborted) process.exit(0);

  // Phase 2: Dedup (only if pi-memory-mem0 is configured)
  const mem0Settings = loadPiSettings<Record<string, unknown>>('pi-memory-mem0');
  if (mem0Settings && Object.keys(mem0Settings).length > 0) {
    const mode = (mem0Settings.mode as string | undefined) ?? 'platform';
    const userId = config.mem0UserId ?? (mem0Settings.userId as string | undefined);

    if (!userId) {
      log(
        'dedup skipped: no explicit userId configured (set pi-memory.dreaming.mem0UserId or pi-memory-mem0.userId)',
      );
    } else {
      try {
        const result = await dedupMemories({
          userId,
          config: { ...mem0Settings, mode } as never,
          signal: abortController.signal,
        });
        log(`dedup done: ${result.duplicatesRemoved} removed from ${result.total}`);
      } catch (err) {
        log(`dedup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Only update state if consolidation ran successfully
  if (consolidationSucceeded) {
    await writeDreamingState({
      lastConsolidatedAt: new Date(now).toISOString(),
      lastSessionCount: recentTurns.length,
    });
  }

  log('done');
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
