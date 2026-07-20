import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { toPiToolResult } from '../tool-result.js';

describe('toPiToolResult', () => {
  it('preserves text-only results when structured content is absent', () => {
    expect(
      toPiToolResult({ content: [{ type: 'text', text: 'Action executed with details.' }] })
        .content,
    ).toEqual([{ type: 'text', text: 'Action executed with details.' }]);
  });

  it('bounds text and structured elements without dropping image content', () => {
    const result = toPiToolResult({
      content: [
        { type: 'image', data: 'image-base64', mimeType: 'image/png' },
        { type: 'text', text: `${'tree row\n'.repeat(8_000)}` },
      ],
      structuredContent: {
        tree_markdown: 'tree row\n'.repeat(8_000),
        elements: Array.from({ length: 4_000 }, (_, index) => ({
          element_index: index,
          element_token: `token-${index}`,
          label: 'x'.repeat(40),
        })),
      },
    });

    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'image-base64',
      mimeType: 'image/png',
    });
    expect(result.content[1]?.type).toBe('text');
    expect((result.content[1] as { text: string }).text).toContain('truncated output');
    expect(result.details?.truncated).toBe(true);
    const boundedPayload = {
      content: result.content.filter((item) => item.type === 'text'),
      details: result.details,
    };
    expect(Buffer.byteLength(JSON.stringify(boundedPayload), 'utf8')).toBeLessThanOrEqual(
      DEFAULT_MAX_BYTES,
    );
  });
});
