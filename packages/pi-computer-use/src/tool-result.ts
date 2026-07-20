import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from '@earendil-works/pi-coding-agent';

const MAX_RESULT_BYTES = DEFAULT_MAX_BYTES - 2 * 1024;
const MAX_DETAILS_BYTES = 18 * 1024;
const SERIALIZATION_OVERHEAD_BYTES = 1_024;

export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content?: McpContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type PiToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fitSerializedString(value: string, maxBytes: number, maxLines: number): string {
  let rawBudget = Math.max(0, maxBytes);
  while (rawBudget > 0) {
    const candidate = truncateHead(value, { maxBytes: rawBudget, maxLines }).content;
    if (byteLength(candidate) <= maxBytes) return candidate;
    rawBudget = Math.floor(rawBudget * 0.75);
  }
  return '';
}

export function boundStructuredContent(
  structuredContent: Record<string, unknown> | undefined,
  maxBytes = MAX_DETAILS_BYTES,
): Record<string, unknown> | undefined {
  if (!structuredContent || byteLength(structuredContent) <= maxBytes) {
    return structuredContent;
  }

  const bounded: Record<string, unknown> = { ...structuredContent, truncated: true };
  if (typeof bounded.tree_markdown === 'string') {
    delete bounded.tree_markdown;
    bounded.tree_markdown_omitted = true;
  }

  const elements = Array.isArray(bounded.elements) ? bounded.elements : undefined;
  if (elements) {
    bounded.total_elements = elements.length;
    let keep = elements.length;
    while (keep > 0 && byteLength({ ...bounded, elements: elements.slice(0, keep) }) > maxBytes) {
      keep = Math.floor(keep / 2);
    }
    bounded.elements = elements.slice(0, keep);
  }

  if (byteLength(bounded) <= maxBytes) return bounded;

  if (maxBytes <= 512) {
    return { truncated: true, original_bytes: byteLength(structuredContent) };
  }

  const serialized = JSON.stringify(structuredContent, null, 2);
  let previewBudget = maxBytes - 512;
  while (previewBudget > 0) {
    const preview = fitSerializedString(serialized, previewBudget, DEFAULT_MAX_LINES);
    const candidate = {
      truncated: true,
      original_bytes: byteLength(structuredContent),
      preview,
    };
    if (byteLength(candidate) <= maxBytes) return candidate;
    previewBudget = Math.floor(previewBudget * 0.75);
  }
  return { truncated: true, original_bytes: byteLength(structuredContent) };
}

export function toPiToolResult(result: McpToolResult): {
  content: PiToolContent[];
  details: Record<string, unknown> | undefined;
  isError?: boolean;
} {
  const content: PiToolContent[] = [];
  const details = boundStructuredContent(result.structuredContent);
  let remainingBytes = Math.max(
    0,
    MAX_RESULT_BYTES - byteLength(details) - SERIALIZATION_OVERHEAD_BYTES,
  );
  let remainingLines = DEFAULT_MAX_LINES;

  for (const item of result.content ?? []) {
    if (item.type === 'image' && item.data) {
      // Keep image blocks valid; Pi's image pipeline applies its own decode/resize
      // limits, while this budget covers the text + details context payload.
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType ?? 'image/png' });
      continue;
    }
    if (item.type !== 'text' || !item.text || remainingBytes <= 0 || remainingLines <= 0) continue;

    const initial = truncateHead(item.text, {
      maxBytes: remainingBytes,
      maxLines: remainingLines,
    });
    const needsTruncation = initial.truncated || byteLength(initial.content) > remainingBytes;
    const noticeCandidate = needsTruncation
      ? `\n\n[pi-computer-use truncated output: ${initial.totalBytes} bytes, ${initial.totalLines} lines]`
      : '';
    const notice = byteLength(noticeCandidate) <= remainingBytes ? noticeCandidate : '';
    const textBudget = Math.max(0, remainingBytes - byteLength(notice));
    const text = `${fitSerializedString(
      item.text,
      textBudget,
      Math.max(1, remainingLines - (notice ? 2 : 0)),
    )}${notice}`;
    if (!text) continue;
    content.push({ type: 'text', text });
    remainingBytes -= byteLength(text);
    remainingLines -= text.split('\n').length;
  }

  if (content.length === 0) content.push({ type: 'text', text: 'Action executed.' });

  return {
    content,
    details,
    ...(result.isError ? { isError: true } : {}),
  };
}
