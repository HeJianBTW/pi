/**
 * Browser task set for the pi-browser-use L3 (task-completion) eval.
 *
 * Each task is a self-contained agentic goal driven through the real `pi` CLI:
 * the model is given the start URL in the prompt and must reach `instruction`
 * using only the whitelisted `browser_*` tools. Sites are chosen to be as stable
 * as possible (static pages, httpbin, a pinned Wikipedia revision) so day-to-day
 * flakiness reflects the browser/model stack, not content churn.
 *
 * Success is decided by `check` — a deterministic predicate over the run's
 * transcript (the model's final answer plus the concatenated tool outputs it
 * saw). Keep predicates tolerant of formatting: lowercase-compare, accept
 * restatements. When a task's success signal genuinely can't be reduced to a
 * string match, leave `check` undefined and the runner defers to the shared LLM
 * judge (judge-llm.ts).
 */

/** Default browser tool allowlist covering navigation + read + basic interaction. */
export const DEFAULT_BROWSER_TOOLS =
  'browser_navigate_page,browser_take_snapshot,browser_click,browser_fill,browser_fill_form,browser_press_key';

export interface BrowserTask {
  id: string;
  /** Page the agent starts on (embedded into the prompt). */
  startUrl: string;
  /** Natural-language goal handed to the model. */
  instruction: string;
  /** Comma-separated `--tools` allowlist. Defaults to DEFAULT_BROWSER_TOOLS. */
  tools?: string;
  /**
   * Deterministic success predicate. Receives the lowercased final answer and
   * the lowercased concatenation of all tool outputs the agent observed.
   * Return true iff the task is complete. Omit to defer to the LLM judge.
   */
  check?: (ctx: { answer: string; observed: string }) => boolean;
  /**
   * Gold string used only by the LLM-judge fallback (judge-llm.ts reads `gold`).
   * Always set it so a judge pass has ground truth even when `check` exists.
   */
  gold: string;
}

const includes = (needle: string) => (ctx: { answer: string; observed: string }) =>
  ctx.answer.includes(needle.toLowerCase()) || ctx.observed.includes(needle.toLowerCase());

export const BROWSER_TASKS: BrowserTask[] = [
  {
    id: 'example-title',
    startUrl: 'https://example.com/',
    instruction:
      'Navigate to the page and report the main heading (the large <h1> text) exactly as it appears.',
    gold: 'Example Domain',
    check: includes('example domain'),
  },
  {
    id: 'example-link-text',
    startUrl: 'https://example.com/',
    instruction:
      'On this page there is a single link in the body. Report the visible text of that link.',
    gold: 'Learn more',
    // example.com's body link text is "Learn more" (verified live). Accept the
    // older "More information" wording too in case the page reverts.
    check: ({ answer, observed }) =>
      /learn more|more information/.test(`${answer}\n${observed}`),
  },
  {
    // example.org is the same IANA-reserved static page as example.com (never
    // changes, tiny). A second read seed that does NOT depend on httpbin.
    id: 'example-org-title',
    startUrl: 'https://example.org/',
    instruction:
      'Navigate to the page and report its main heading (the large <h1> text).',
    gold: 'Example Domain',
    check: includes('example domain'),
  },
  {
    // Form fill + submit on a stable automation test site (the-internet is the
    // standard SeleniumHQ demo site — content is fixed, unlike httpbin which was
    // observed flaking with 503s). Fills two fields and clicks Login; the known
    // valid credentials land on a "Secure Area" page.
    id: 'login-form-submit',
    startUrl: 'https://the-internet.herokuapp.com/login',
    instruction:
      'This is a login form. Enter the username "tomsmith" and the password "SuperSecretPassword!", then click the Login button. After logging in, report the heading or confirmation message shown on the resulting page.',
    gold: 'Secure Area',
    tools:
      'browser_navigate_page,browser_take_snapshot,browser_click,browser_fill,browser_fill_form,browser_wait_for',
    check: ({ answer, observed }) =>
      /secure area|logged into/i.test(`${answer}\n${observed}`),
  },
  {
    id: 'wikipedia-pinned-first-sentence',
    // Pinned oldid so the article text cannot drift between runs.
    startUrl:
      'https://en.wikipedia.org/w/index.php?title=Web_browser&oldid=1230000000',
    instruction:
      'Read the first sentence of this article and report what kind of software application a "web browser" is described as.',
    gold: 'application for accessing websites',
    // Tolerant: the lead defines it as an application for accessing the World
    // Wide Web / websites. Accept either phrasing.
    check: ({ answer, observed }) => {
      const hay = `${answer}\n${observed}`;
      return /web browser/.test(hay) && /(access|accessing).*(web|website|internet)/.test(hay);
    },
  },
  {
    // Multi-step navigation: click a link on the index, land on a new page,
    // re-snapshot (uids invalidate after the click) and read it — exercising the
    // extension's stale-element handling. the-internet's index is a fixed list of
    // named example links, so the target text is deterministic.
    id: 'multi-step-navigate',
    startUrl: 'https://the-internet.herokuapp.com/',
    instruction:
      'This page is an index of example links. Click the link titled "A/B Testing". After the new page loads, take a fresh snapshot and report the main heading shown on that page.',
    gold: 'A/B Test',
    tools:
      'browser_navigate_page,browser_take_snapshot,browser_click,browser_wait_for',
    check: ({ answer, observed }) => /a\/b test/i.test(`${answer}\n${observed}`),
  },
];
