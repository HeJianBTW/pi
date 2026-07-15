#!/usr/bin/env node
/**
 * pi-computer-use L3 eval: desktop task-completion rate, driven through the REAL
 * `pi` CLI. Same shape as the browser eval, one level lower: installs
 * pi-computer-use into an isolated pi config dir and runs each task in
 * computer/tasks.ts via `pi --mode json -p '<task>' --tools <allowlist>`, driving
 * real macOS apps through the cua-driver the extension bundles. Scoring is the
 * task's deterministic `check`.
 *
 * REQUIRES: macOS, `pi` on PATH, the bundled cua-driver binary, a working
 * provider (--models <models.json> or --base-url + PI_INTEGRATION_API_KEY), and
 * Accessibility + Screen Recording granted to the process. Apps launch visibly
 * and receive synthetic input. Skips gracefully on non-macOS. See README.
 *
 * Usage:
 *   PI_INTEGRATION_BASE_URL=... PI_INTEGRATION_API_KEY=... \
 *     pnpm --filter @amaster.ai/pi-eval eval:computer -- --model deepseek-v4-flash
 *   # or with a ready models.json (what CI does):
 *   pnpm --filter @amaster.ai/pi-eval eval:computer -- --models /path/to/models.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DriveResult,
  drivePrompt,
  type FailureMode,
  parseCommonArgs,
  setupHarness,
  toHarnessConfig,
} from '../src/pi-harness.js';
import { DEFAULT_COMPUTER_TOOLS, type DesktopTask, DESKTOP_TASKS } from './tasks.js';

interface Row {
  task: string;
  question: string;
  gold: string;
  success: number;
  hasCheck: boolean;
  turns: number;
  toolCalls: number;
  failureMode: FailureMode;
  answer: string;
  blob: string;
  error?: string;
}

function buildPrompt(task: DesktopTask): string {
  return `Target app: ${task.appName} (bundle id: ${task.bundleId})\n\nTask: ${task.instruction}\n\nLaunch the target app first (computer_use_launch_app), then use list_windows + get_window_state to inspect it, act, and reply with a final plain-text answer stating the requested value.`;
}

function scoreTask(task: DesktopTask, drive: DriveResult): Row {
  const observed = drive.observed.toLowerCase();
  const answer = drive.answer.toLowerCase();
  let failureMode = drive.failureMode;
  let success = 0;

  if (failureMode === 'ok') {
    if (task.check) {
      const passed = task.check({ answer, observed });
      success = passed ? 1 : 0;
      if (!passed) failureMode = drive.sawToolError ? 'tool-error' : 'check-failed';
    } else if (drive.sawToolError) {
      failureMode = 'tool-error';
    }
  }

  return {
    task: task.id,
    question: task.instruction,
    gold: task.gold,
    success,
    hasCheck: Boolean(task.check),
    turns: drive.turns,
    toolCalls: drive.toolCalls,
    failureMode,
    answer: drive.answer,
    blob: `FINAL ANSWER: ${drive.answer}\n\nOBSERVED:\n${drive.observed}`,
    ...(drive.error ? { error: drive.error } : {}),
  };
}

async function main() {
  // Desktop automation needs a real macOS session + TCC grants. On any other
  // platform (e.g. Linux CI) skip GRACEFULLY — write an empty skipped result and
  // exit 0 so this never fails a cross-platform pipeline.
  if (process.platform !== 'darwin') {
    process.stderr.write(
      `[eval:computer] skipped: requires macOS desktop (got ${process.platform}). ` +
        'cua-driver drives real apps and needs Accessibility + Screen Recording.\n',
    );
    const outDir = path.resolve(import.meta.dirname, '..', 'results');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, 'computer-tasks.json'),
      JSON.stringify(
        { summary: { skipped: true, reason: `platform ${process.platform} is not macOS` }, rows: [] },
        null,
        2,
      ),
    );
    return;
  }

  const args = parseCommonArgs({ model: 'deepseek-v4-flash', timeoutMs: 240_000 });
  const hcfg = toHarnessConfig(args);

  let selected = args.taskId
    ? DESKTOP_TASKS.filter((t) => t.id === args.taskId)
    : DESKTOP_TASKS;
  if (args.tasks > 0) selected = selected.slice(0, args.tasks);
  if (selected.length === 0) throw new Error('no tasks selected');

  process.stderr.write(
    `[eval:computer] tasks=${selected.length} model=${args.provider}/${args.model}\n`,
  );
  process.stderr.write(
    '[eval:computer] NOTE: needs Accessibility + Screen Recording granted to this process; apps will visibly launch.\n',
  );

  const harness = await setupHarness(hcfg, {
    pkg: 'pi-computer-use',
    settings: { 'pi-computer-use': { mode: 'bundled' } },
  });

  const rows: Row[] = [];
  try {
    for (const task of selected) {
      process.stderr.write(`[eval:computer] start ${task.id}\n`);
      const drive = await drivePrompt(
        harness,
        hcfg,
        buildPrompt(task),
        task.tools ?? DEFAULT_COMPUTER_TOOLS,
      );
      const row = scoreTask(task, drive);
      rows.push(row);
      process.stderr.write(
        `[eval:computer] done ${task.id}: success=${row.success} mode=${row.failureMode} turns=${row.turns} tools=${row.toolCalls}${row.error ? ` err=${row.error.slice(0, 80)}` : ''}\n`,
      );
    }
  } finally {
    harness.cleanup();
  }

  const checked = rows.filter((r) => r.hasCheck && r.failureMode !== 'crash');
  const successRate = checked.reduce((a, r) => a + r.success, 0) / Math.max(1, checked.length);
  const avgToolCalls = rows.reduce((a, r) => a + r.toolCalls, 0) / Math.max(1, rows.length);
  // Turns-to-success only (see browser runner rationale).
  const passed = rows.filter((r) => r.success === 1);
  const avgTurns = passed.reduce((a, r) => a + r.turns, 0) / Math.max(1, passed.length);
  const failureMix: Record<string, number> = {};
  for (const r of rows) failureMix[r.failureMode] = (failureMix[r.failureMode] ?? 0) + 1;

  const summary = {
    model: `${args.provider}/${args.model}`,
    n: rows.length,
    nChecked: checked.length,
    successRate,
    avgTurns,
    avgToolCalls,
    failureMix,
  };
  process.stderr.write(`[eval:computer] ${JSON.stringify(summary)}\n`);

  const outDir = path.resolve(import.meta.dirname, '..', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'computer-tasks.json'), JSON.stringify({ summary, rows }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[eval:computer] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
