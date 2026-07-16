#!/usr/bin/env node
/**
 * pi-browser-use L3 eval: task-completion rate, driven through the REAL `pi` CLI.
 *
 * Sets up an isolated pi config dir, installs pi-browser-use, then runs each task
 * in browser/tasks.ts via `pi --mode json -p '<task>' --tools <allowlist>` and
 * scores the result with the task's deterministic `check`. Because the extension
 * is installed and run exactly as shipped, the success rate reflects the real
 * wrapper (snapshot handling, tool descriptions, overlay/stale hints) plus the
 * model — no importing package internals.
 *
 * REQUIRES: `pi` on PATH, a real Chrome (found via CHROME_BIN or common paths),
 * and a working provider — either --models <models.json> or --base-url +
 * PI_INTEGRATION_API_KEY. Runs on Linux/macOS. See README.
 *
 * Usage:
 *   PI_INTEGRATION_BASE_URL=... PI_INTEGRATION_API_KEY=... \
 *     pnpm --filter @amaster.ai/pi-eval eval:browser -- --model deepseek-v4-flash
 *   # or with a ready models.json (what CI does):
 *   pnpm --filter @amaster.ai/pi-eval eval:browser -- --models /path/to/models.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DriveResult,
  drivePrompt,
  type FailureMode,
  parseCommonArgs,
  setupHarness,
  toHarnessConfig,
} from '../src/pi-harness.js';
import { type BrowserTask, BROWSER_TASKS, DEFAULT_BROWSER_TOOLS } from './tasks.js';

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

/**
 * Locate a Chrome/Chromium binary for chrome-devtools-mcp, cross-platform.
 * Override via CHROME_BIN. Checks common macOS + Linux locations; returns
 * undefined if none found (caller prints the npx-install hint).
 */
function resolveChrome(): string | undefined {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  return candidates.find((c) => existsSync(c));
}

function buildPrompt(task: BrowserTask): string {
  return `Start URL: ${task.startUrl}\n\nTask: ${task.instruction}\n\nNavigate to the start URL first (take a snapshot after each navigation/action to see the page), then complete the task and reply with a final plain-text answer stating the requested value.`;
}

function scoreTask(task: BrowserTask, drive: DriveResult): Row {
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
  const args = parseCommonArgs({ model: 'deepseek-v4-flash', timeoutMs: 180_000 });
  const hcfg = toHarnessConfig(args);

  const chrome = resolveChrome();
  if (!chrome) {
    throw new Error(
      'No Chrome binary found. Set CHROME_BIN, or install one: ' +
        '`npx -y @puppeteer/browsers install chrome@stable --path <dir>` then point CHROME_BIN at it. ' +
        '(On Linux CI this is the same step integration.yml uses.)',
    );
  }

  let selected = args.taskId
    ? BROWSER_TASKS.filter((t) => t.id === args.taskId)
    : BROWSER_TASKS;
  if (args.tasks > 0) selected = selected.slice(0, args.tasks);
  if (selected.length === 0) throw new Error('no tasks selected');

  process.stderr.write(
    `[eval:browser] tasks=${selected.length} model=${args.provider}/${args.model} chrome=${chrome}\n`,
  );

  const harness = await setupHarness(hcfg, {
    pkg: 'pi-browser-use',
    settings: {
      'pi-browser-use': {
        headless: true,
        sessionMode: 'isolated',
        viewport: '1280x720',
        executablePath: chrome,
      },
    },
  });

  const rows: Row[] = [];
  try {
    // Sequential: chrome-devtools-mcp is stateful per session, and each `pi`
    // invocation spins up its own isolated browser anyway.
    for (const task of selected) {
      process.stderr.write(`[eval:browser] start ${task.id}\n`);
      const drive = await drivePrompt(
        harness,
        hcfg,
        buildPrompt(task),
        task.tools ?? DEFAULT_BROWSER_TOOLS,
      );
      const row = scoreTask(task, drive);
      rows.push(row);
      process.stderr.write(
        `[eval:browser] done ${task.id}: success=${row.success} mode=${row.failureMode} turns=${row.turns} tools=${row.toolCalls}${row.error ? ` err=${row.error.slice(0, 80)}` : ''}\n`,
      );
    }
  } finally {
    harness.cleanup();
  }

  const checked = rows.filter((r) => r.hasCheck && r.failureMode !== 'crash');
  const successRate = checked.reduce((a, r) => a + r.success, 0) / Math.max(1, checked.length);
  const avgToolCalls = rows.reduce((a, r) => a + r.toolCalls, 0) / Math.max(1, rows.length);
  // Turns-to-success: efficiency of the runs that actually completed. Averaging
  // over failures would conflate "slow" with "gave up", so restrict to passes.
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
  process.stderr.write(`[eval:browser] ${JSON.stringify(summary)}\n`);

  const outDir = path.resolve(import.meta.dirname, '..', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'browser-tasks.json'), JSON.stringify({ summary, rows }, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[eval:browser] error: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
