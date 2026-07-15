/**
 * Build a compact text transcript from agent messages for derive/evaluate.
 * Works backwards from the newest message so the most recent context survives
 * the char cap (same approach as pi-memory's serializer).
 */

interface MessageLike {
  role: string;
  content: unknown;
}

export function buildTranscript(messages: unknown[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MessageLike | undefined;
    if (!msg || typeof msg.role !== 'string') continue;
    const text = extractText(msg.content);
    if (!text) continue;
    const line = `[${msg.role}] ${text}`;
    if (total + line.length > maxChars && lines.length > 0) break;
    lines.unshift(line);
    total += line.length;
  }

  return lines.join('\n\n');
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
