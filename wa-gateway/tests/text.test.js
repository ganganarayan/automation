import { describe, it, expect } from 'vitest';
import { applyLineBreakMarkers, splitIntoBubbles, substituteTemplate } from '../src/utils/text.js';

describe('applyLineBreakMarkers', () => {
  it('converts || to a blank line and | to a newline', () => {
    expect(applyLineBreakMarkers('a||b|c')).toBe('a\n\nb\nc');
  });
  it('handles empty input', () => {
    expect(applyLineBreakMarkers('')).toBe('');
  });
});

describe('substituteTemplate', () => {
  it('replaces name, email and [link]', () => {
    const out = substituteTemplate('Hi {{name}} ({{email}}) [link]', {
      name: 'Jane',
      email: 'j@x.com',
      link: 'https://x.com',
    });
    expect(out).toBe('Hi Jane (j@x.com) https://x.com');
  });
  it('is case-insensitive on tokens', () => {
    expect(substituteTemplate('{{NAME}}', { name: 'Jo' })).toBe('Jo');
  });
});

describe('splitIntoBubbles', () => {
  it('splits paragraphs into bubbles with clamped delays', () => {
    const bubbles = splitIntoBubbles('First paragraph.\n\nSecond paragraph here.');
    expect(bubbles).toHaveLength(2);
    for (const b of bubbles) {
      expect(b.delaySeconds).toBeGreaterThanOrEqual(4);
      expect(b.delaySeconds).toBeLessThanOrEqual(20);
    }
  });

  it('falls back to sentence splitting for a single block', () => {
    const bubbles = splitIntoBubbles('One sentence. Two sentence. Three sentence.');
    expect(bubbles.length).toBeGreaterThanOrEqual(3);
  });

  it('drops lines mentioning a VSL or watch video', () => {
    const bubbles = splitIntoBubbles('Keep this.\n\nWatch the video now.\n\nAlso keep this.');
    expect(bubbles.map((b) => b.text)).not.toContain('Watch the video now.');
    expect(bubbles).toHaveLength(2);
  });

  it('does not split on protected abbreviations', () => {
    const bubbles = splitIntoBubbles('You should see Dr. Rao soon. He can help.');
    // "Dr. Rao soon." must not be split at "Dr."
    expect(bubbles[0].text.startsWith('You should see Dr. Rao')).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    expect(splitIntoBubbles('')).toEqual([]);
  });
});
