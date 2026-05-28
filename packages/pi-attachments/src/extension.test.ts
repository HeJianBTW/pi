import { describe, expect, it } from 'vitest';

// Test the core parsing/extraction logic directly
const QUOTED_AT_RE = /(^|\s)@"([^"]+)"/g;
const REGULAR_AT_RE = /(^|\s)@([^\s@"]+)/g;

function extractAtMentions(content: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(QUOTED_AT_RE)) {
    const value = match[2]!;
    if (!seen.has(value)) {
      seen.add(value);
      mentions.push(value);
    }
  }
  for (const match of content.matchAll(REGULAR_AT_RE)) {
    const value = match[2]!;
    if (!seen.has(value) && !value.startsWith('http')) {
      seen.add(value);
      mentions.push(value);
    }
  }
  return mentions;
}

function stripAtMentions(content: string): string {
  return content.replace(QUOTED_AT_RE, '$1').replace(REGULAR_AT_RE, '$1').trim();
}

describe('extractAtMentions', () => {
  it('extracts unquoted @path references', () => {
    const result = extractAtMentions('check @src/main.ts please');
    expect(result).toEqual(['src/main.ts']);
  });

  it('extracts quoted @"path" references', () => {
    const result = extractAtMentions('review @"/path with spaces/file.ts"');
    expect(result).toEqual(['/path with spaces/file.ts']);
  });

  it('extracts multiple references', () => {
    const result = extractAtMentions('@src/a.ts @src/b.ts explain these');
    expect(result).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('deduplicates repeated references', () => {
    const result = extractAtMentions('@foo.ts and @foo.ts again');
    expect(result).toEqual(['foo.ts']);
  });

  it('ignores http URLs', () => {
    const result = extractAtMentions('see @https://example.com');
    expect(result).toEqual([]);
  });

  it('handles line range syntax', () => {
    const result = extractAtMentions('look at @src/main.ts#L10-20');
    expect(result).toEqual(['src/main.ts#L10-20']);
  });

  it('returns empty for no mentions', () => {
    const result = extractAtMentions('just a normal message');
    expect(result).toEqual([]);
  });

  it('handles @ at start of text', () => {
    const result = extractAtMentions('@file.ts');
    expect(result).toEqual(['file.ts']);
  });
});

describe('stripAtMentions', () => {
  it('removes unquoted mentions', () => {
    const result = stripAtMentions('check @src/main.ts please');
    expect(result).toBe('check  please');
  });

  it('removes quoted mentions', () => {
    const result = stripAtMentions('review @"/tmp/file.ts" now');
    expect(result).toBe('review  now');
  });

  it('removes all mentions and trims', () => {
    const result = stripAtMentions('@a.ts @b.ts explain');
    expect(result).toBe('explain');
  });
});
