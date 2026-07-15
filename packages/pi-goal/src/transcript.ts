/**
 * Build a compact text transcript from agent messages for derive/evaluate.
 * Works backwards from the newest message so the most recent context survives
 * the char cap (same approach as pi-memory's serializer).
 */

interface MessageLike {
  role: string;
  content: unknown;
}

export interface TranscriptResult {
  /** Formatted transcript, oldest included message first. */
  text: string;
  /** Count of text-bearing messages dropped because of the char cap. */
  omitted: number;
}

/**
 * Build the transcript and report how many text-bearing messages were dropped
 * to fit the cap. The evaluator uses `omitted` to decide whether to warn that
 * evidence may live in the truncated prefix (see buildTruncationNote).
 */
export function buildTranscriptWithMeta(messages: unknown[], maxChars: number): TranscriptResult {
  const lines: string[] = [];
  let total = 0;
  let included = 0;
  let textMessages = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike | undefined;
    if (!msg || typeof msg.role !== 'string') continue;
    const text = extractText(msg.content);
    if (!text) continue;
    textMessages += 1;
    const line = `[${msg.role}] ${text}`;
    if (total + line.length > maxChars && lines.length > 0) {
      // Cap hit: this and every older text message is omitted.
      continue;
    }
    lines.unshift(line);
    total += line.length;
    included += 1;
  }

  return { text: lines.join('\n\n'), omitted: Math.max(0, textMessages - included) };
}

export function buildTranscript(messages: unknown[], maxChars: number): string {
  return buildTranscriptWithMeta(messages, maxChars).text;
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n')
      .trim();
  }
  return '';
}
