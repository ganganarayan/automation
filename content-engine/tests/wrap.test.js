import { describe, it, expect } from 'vitest';
import { wrapHook } from '../src/utils/wrap.js';

describe('wrapHook', () => {
  it('keeps short text on one line with the largest font', () => {
    const r = wrapHook('Short hook');
    expect(r.lines).toEqual(['Short hook']);
    expect(r.fontSize).toBe(64);
    expect(r.truncated).toBe(false);
  });

  it('wraps into multiple lines and lowers the font', () => {
    const r = wrapHook('This is a considerably longer hook that needs wrapping', { maxChars: 20, maxLines: 3 });
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.lines.length).toBeLessThanOrEqual(3);
    expect([64, 56, 46]).toContain(r.fontSize);
  });

  it('truncates with an ellipsis when over the line budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const r = wrapHook(long, { maxChars: 12, maxLines: 3 });
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBe(3);
    expect(r.lines[r.lines.length - 1].endsWith('…')).toBe(true);
  });

  it('respects each line length budget', () => {
    const r = wrapHook('alpha beta gamma delta epsilon', { maxChars: 12, maxLines: 3 });
    for (const line of r.lines) {
      // allow the ellipsis to push slightly past
      expect(line.replace('…', '').length).toBeLessThanOrEqual(12);
    }
  });
});
