import { describe, expect, test } from 'vitest';
import {
  augmentToolDescription,
  extractTextContent,
  postProcessToolResult,
} from '../tool-augment.js';

describe('augmentToolDescription', () => {
  test('appends hint for click tool', () => {
    const result = augmentToolDescription('click', 'Click an element.');
    expect(result).toContain('Click an element.');
    expect(result).toContain('uid');
  });

  test('appends hint for fill tool', () => {
    const result = augmentToolDescription('fill', 'Fill a field.');
    expect(result).toContain('canvas');
  });

  test('appends hint for fill_form tool', () => {
    const result = augmentToolDescription('fill_form', 'Fill form fields.');
    expect(result).toContain('Same limitations as fill');
  });

  test('appends hint for press_key tool', () => {
    const result = augmentToolDescription('press_key', 'Press a key.');
    expect(result).toContain('SINGLE keyboard key');
  });

  test('appends hint for take_snapshot tool', () => {
    const result = augmentToolDescription('take_snapshot', 'Take snapshot.');
    expect(result).toContain('Call this FIRST');
  });

  test('appends hint for navigate_page tool', () => {
    const result = augmentToolDescription('navigate_page', 'Navigate.');
    expect(result).toContain('take_snapshot');
  });

  test('appends hint for new_page tool', () => {
    const result = augmentToolDescription('new_page', 'New page.');
    expect(result).toContain('take_snapshot');
  });

  test('appends hint for click_at tool', () => {
    const result = augmentToolDescription('click_at', 'Click at coordinates.');
    expect(result).toContain('pixel coordinates');
  });

  test('appends hint for hover tool', () => {
    const result = augmentToolDescription('hover', 'Hover over element.');
    expect(result).toContain('uid');
  });

  test('returns description unchanged for unknown tool', () => {
    const result = augmentToolDescription('unknown_tool', 'Some description.');
    expect(result).toBe('Some description.');
  });

  test('returns description unchanged for evaluate_script', () => {
    const result = augmentToolDescription('evaluate_script', 'Evaluate JS.');
    expect(result).toBe('Evaluate JS.');
  });
});

describe('postProcessToolResult', () => {
  test('strips embedded snapshot from non-snapshot tool', () => {
    const input = 'Action result\n## Latest page snapshot\n<tree>...</tree>';
    const result = postProcessToolResult('click', input);
    expect(result).toContain('Action result');
    expect(result).not.toContain('Latest page snapshot');
  });

  test('does NOT strip snapshot from take_snapshot result', () => {
    const input = 'Snapshot\n## Latest page snapshot\n<tree>...</tree>';
    const result = postProcessToolResult('take_snapshot', input);
    expect(result).toContain('Latest page snapshot');
  });

  test('appends overlay hint for click with overlay pattern', () => {
    const patterns = [
      'not interactable',
      'obscured',
      'intercept',
      'blocked',
      'element is not visible',
      'element not found',
    ];
    for (const pattern of patterns) {
      const result = postProcessToolResult('click', `Error: ${pattern}`);
      expect(result).toContain('overlay');
    }
  });

  test('does not append overlay hint for non-click tool', () => {
    const result = postProcessToolResult('fill', 'Error: not interactable');
    expect(result).not.toContain('overlay');
  });

  test('appends stale hint when result contains stale', () => {
    const result = postProcessToolResult('click', 'Error: stale element reference');
    expect(result).toContain('take_snapshot');
    expect(result).toContain('stale');
  });

  test('appends stale hint when result contains detached', () => {
    const result = postProcessToolResult('fill', 'Error: element is detached from DOM');
    expect(result).toContain('take_snapshot');
  });

  test('passes clean result through unchanged', () => {
    const input = 'Successfully clicked element uid="12_3"';
    const result = postProcessToolResult('click', input);
    expect(result).toBe(input);
  });

  test('click_at also gets overlay hint', () => {
    const result = postProcessToolResult('click_at', 'Error: element is not visible');
    expect(result).toContain('overlay');
  });

  test('both overlay and stale patterns trigger both hints', () => {
    const result = postProcessToolResult('click', 'Error: element is stale and not interactable');
    expect(result).toContain('overlay');
    expect(result).toContain('take_snapshot');
  });

  test('preserves original content when no patterns match', () => {
    const input = 'Navigated to https://example.com';
    const result = postProcessToolResult('navigate_page', input);
    expect(result).toBe(input);
  });

  test('strips only snapshot section, preserves preceding content', () => {
    const input = 'First line\nSecond line\n## Latest page snapshot\n<tree>big tree</tree>';
    const result = postProcessToolResult('fill', input);
    expect(result).toBe('First line\nSecond line');
  });
});

describe('extractTextContent', () => {
  test('extracts text from content array', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    expect(extractTextContent(content)).toBe('Hello\nWorld');
  });

  test('filters non-text items', () => {
    const content = [
      { type: 'image', text: undefined },
      { type: 'text', text: 'Only text' },
    ];
    expect(extractTextContent(content as { type: string; text?: string }[])).toBe('Only text');
  });

  test('returns empty string for undefined', () => {
    expect(extractTextContent(undefined)).toBe('');
  });

  test('returns empty string for empty array', () => {
    expect(extractTextContent([])).toBe('');
  });
});
