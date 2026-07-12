import { describe, it, expect } from 'vitest';
import { humanizeCaption, withChannelLink } from '../src/utils/caption.js';

describe('humanizeCaption', () => {
  it('replaces em/en dashes and arrows', () => {
    const out = humanizeCaption('Focus — then act → win');
    expect(out).not.toMatch(/[—–→]/);
    expect(out).toContain('-');
  });
  it('collapses excess blank lines and trims', () => {
    expect(humanizeCaption('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('prefixes an audience line', () => {
    expect(humanizeCaption('body', 'Founders')).toBe('Founders:\nbody');
  });
  it('omits the prefix when no audience', () => {
    expect(humanizeCaption('body')).toBe('body');
  });
});

describe('withChannelLink', () => {
  it('appends a channel-tagged link', () => {
    expect(withChannelLink('cap', 'https://x.com/a', 'instagram')).toBe('cap\n\nhttps://x.com/a?channel=instagram');
  });
  it('falls back to organic for unknown channels', () => {
    expect(withChannelLink('cap', 'https://x.com/a', 'nope')).toContain('channel=organic');
  });
  it('uses & when the base link already has a query', () => {
    expect(withChannelLink('cap', 'https://x.com/a?ref=1', 'x')).toContain('?ref=1&channel=x');
  });
});
