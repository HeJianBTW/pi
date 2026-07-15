import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../evaluate.js';

describe('parseVerdict', () => {
  it('parses a clean "met" verdict', () => {
    const v = parseVerdict('{"ok": true, "reason": "tests pass"}');
    expect(v).toEqual({ ok: true, impossible: false, reason: 'tests pass' });
  });

  it('parses a "not yet" verdict', () => {
    const v = parseVerdict('{"ok": false, "reason": "2 tests failing"}');
    expect(v).toEqual({ ok: false, impossible: false, reason: '2 tests failing' });
  });

  it('parses an "impossible" verdict', () => {
    const v = parseVerdict('{"ok": false, "impossible": true, "reason": "contradictory"}');
    expect(v).toEqual({ ok: false, impossible: true, reason: 'contradictory' });
  });

  it('ignores impossible when ok is true', () => {
    const v = parseVerdict('{"ok": true, "impossible": true, "reason": "done"}');
    expect(v.ok).toBe(true);
    expect(v.impossible).toBe(false);
  });

  it('extracts JSON embedded in prose / code fences', () => {
    const v = parseVerdict('Here is my verdict:\n```json\n{"ok": true, "reason": "ok"}\n```');
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('ok');
  });

  it('treats unparseable output conservatively as not-yet-met', () => {
    const v = parseVerdict('I think it is probably fine, hard to say.');
    expect(v.ok).toBe(false);
    expect(v.impossible).toBe(false);
    expect(v.reason).toMatch(/continu/i);
  });

  it('fills a default reason when reason is missing', () => {
    expect(parseVerdict('{"ok": true}').reason).toBeTruthy();
    expect(parseVerdict('{"ok": false}').reason).toBeTruthy();
  });
});
