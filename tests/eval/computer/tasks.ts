/**
 * Desktop task set for the pi-computer-use L3 (task-completion) eval.
 *
 * Driven through the real `pi` CLI. Unlike browser tasks (URL-driven), desktop
 * tasks are app-driven: the agent must launch/target a real macOS app by
 * pid + window_id and drive its AX tree. Seeds are built-in system apps so
 * results are deterministic and offline — the default is Calculator
 * (com.apple.calculator): launch → read/click buttons → read the display.
 *
 * Success is decided by `check(answer, observed)` over the run transcript (the
 * model's final answer plus the concatenated tool outputs it saw). Tasks that
 * can't be reduced to a match omit `check` and defer to judge-llm.ts; every task
 * still sets `gold` for that fallback.
 *
 * REQUIRES a real macOS desktop session with Accessibility + Screen Recording
 * granted to the process running the eval. Cannot run headless / in CI.
 */

/** Default computer_use tool allowlist covering launch → inspect → act → read. */
export const DEFAULT_COMPUTER_TOOLS =
  'computer_use_launch_app,computer_use_list_windows,computer_use_get_window_state,computer_use_click,computer_use_type_text,computer_use_press_key,computer_use_get_accessibility_tree';

export interface DesktopTask {
  id: string;
  /** Bundle id the agent should launch/target first. */
  bundleId: string;
  /** Human-readable app name (used in the instruction). */
  appName: string;
  /** Natural-language goal handed to the model. */
  instruction: string;
  /** Comma-separated `--tools` allowlist. Defaults to DEFAULT_COMPUTER_TOOLS. */
  tools?: string;
  /**
   * Deterministic success predicate over the lowercased final answer and the
   * lowercased concatenation of all tool outputs observed. Omit to defer to the
   * LLM judge.
   */
  check?: (ctx: { answer: string; observed: string }) => boolean;
  /** Gold string for the judge-llm.ts fallback. Always set. */
  gold: string;
}

const includes = (needle: string) => (ctx: { answer: string; observed: string }) =>
  ctx.answer.includes(needle.toLowerCase()) || ctx.observed.includes(needle.toLowerCase());

export const DESKTOP_TASKS: DesktopTask[] = [
  {
    id: 'calc-add',
    bundleId: 'com.apple.calculator',
    appName: 'Calculator',
    instruction:
      'Using the Calculator app, compute 7 + 8 by clicking the buttons (7, then +, then 8, then =). Then report the number shown on the calculator display.',
    gold: '15',
    check: includes('15'),
  },
  {
    id: 'calc-multiply',
    bundleId: 'com.apple.calculator',
    appName: 'Calculator',
    instruction:
      'Using the Calculator app, compute 6 × 9 (click 6, then the multiply button ×, then 9, then =). Report the number shown on the display.',
    gold: '54',
    check: includes('54'),
  },
  {
    id: 'calc-read-window-title',
    bundleId: 'com.apple.calculator',
    appName: 'Calculator',
    instruction:
      'Launch the Calculator app and inspect its window. Report the title of the Calculator window as it appears in the accessibility tree.',
    gold: 'Calculator',
    check: includes('calculator'),
  },
  {
    id: 'textedit-type',
    bundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
    instruction:
      'Open TextEdit (it will show a new blank document), then type the exact text PiEvalOK into the document. Confirm by reporting the text that now appears in the document body.',
    gold: 'PiEvalOK',
    check: includes('pievalok'),
  },
  {
    id: 'notes-read-list',
    bundleId: 'com.apple.Notes',
    appName: 'Notes',
    instruction:
      'Launch the Notes app and inspect its window with get_window_state. Report the title of one note visible in the notes list, or state clearly that the list is empty.',
    gold: 'a note title or empty',
    // Content is user-specific, so accept any plausible completion signal: the app
    // opened and its AX tree was read (a note title, or an explicit "empty"/"no notes").
    check: ({ observed, answer }) =>
      /notes|note|empty|no notes/.test(`${answer}\n${observed}`),
  },
  {
    // Real-world agentic interaction: launch NetEase Cloud Music and navigate to
    // its "每日推荐" (Daily Recommendation) entry. Content requires login and
    // changes daily, so we only verify the agent reached a recommendation-related
    // view — not specific songs. Exercises launch → inspect AX tree → click.
    id: 'netease-daily-recommend',
    bundleId: 'com.netease.163music',
    appName: '网易云音乐 (NetEase Cloud Music)',
    instruction:
      'Launch NetEase Cloud Music. In its window, find and click the "每日推荐" (Daily Recommendation) navigation entry in the left sidebar. After clicking, report what section or page title is now shown.',
    gold: '每日推荐 / Daily Recommendation view',
    // Tolerant: success = the agent found and acted on the 每日推荐 entry (its label
    // appears in the AX tree it read, or the answer references reaching it).
    check: ({ observed, answer }) => {
      const hay = `${answer}\n${observed}`;
      return /每日推荐|daily recommend|recommendation/i.test(hay);
    },
  },
];
