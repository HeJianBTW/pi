/**
 * Shared OpenAI-compatible judge client for the results-judging scripts
 * (judge-llm, judge-video): CLI flag helper, models.json resolution,
 * transient-retry chat call, and a small worker pool. Payload shape and reply
 * parsing stay per-script.
 */
import { readFileSync } from 'node:fs';

export interface JudgeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** CLI flag helper shared by the eval scripts. */
export function getFlag(argv: string[], flag: string, dflt: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1]! : dflt;
}

export function loadJudgeConfig(modelsPath: string, provider: string, model: string): JudgeConfig {
  const models = JSON.parse(readFileSync(modelsPath, 'utf8')) as {
    providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
  };
  const entry = models.providers?.[provider];
  if (!entry?.apiKey || !entry.baseUrl) {
    throw new Error(`provider ${provider} missing apiKey/baseUrl in ${modelsPath}`);
  }
  // models.json may reference the key by env name ($VAR / ${VAR}) — resolve it
  // here; pi does the same at runtime for its own providers.
  const ref = /^\$\{?([A-Z0-9_]+)\}?$/.exec(entry.apiKey);
  const apiKey = ref ? process.env[ref[1]!] : entry.apiKey;
  if (!apiKey) {
    throw new Error(`provider ${provider} apiKey references $${ref![1]} which is not set`);
  }
  return { apiKey, baseUrl: entry.baseUrl, model };
}

export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const haystack = `${msg}\n${cause}`;
  return /\b(5\d\d|429|overloaded|timeout|timed out|ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND|getaddrinfo|fetch failed|socket|Connection error|APIConnection)\b/i.test(
    haystack,
  );
}

/**
 * POST /chat/completions with transient retry; returns the assistant text.
 * `messages` is untyped — judge-video sends multimodal content parts.
 * Reply-parse errors belong to the caller and are NOT retried (not transient).
 */
export async function chatCompletion(
  cfg: JudgeConfig,
  body: { maxTokens: number; messages: unknown[]; temperature?: number },
): Promise<string> {
  const delays = [1000, 4000, 16000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        // A hung gateway must not park a pool worker forever; the abort error
        // matches isTransient ('timed out') and retries.
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          model: cfg.model,
          // Optional: some models reject anything but their own default
          // (kimi-k3: "only 1 is allowed"), so callers omit rather than force 0.
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          max_tokens: body.maxTokens,
          messages: body.messages,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length || !isTransient(err)) break;
      await new Promise((r) => setTimeout(r, delays[attempt]!));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Simple cursor worker pool over items. */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
}
