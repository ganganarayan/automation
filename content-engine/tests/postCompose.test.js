import { describe, it, expect } from 'vitest';
import { extractRow, composePrompt, composeCaptions, buildPlatformConfigs } from '../src/utils/postCompose.js';

// Corporate-style sheet (per-platform captions, Post # match key)
const corpHeader = ['Post #', 'Weekly Title (Theme)', 'image prompt', 'Locked Text Specs', 'Headline', 'Subhead', 'LinkedIn Long Caption (full post)', 'Short Caption (other 6 channels, optional)', 'Hashtags', 'Status'];
const corpRow = ['12', 'Focus', 'a calm exec', 'specs here', 'Lead with clarity', 'sub here', 'Long LinkedIn body...', 'Short punchy body', '#leadership #gita', 'Ready'];

// Gita-style sheet (single caption, day match key)
const gitaHeader = ['day', 'image_prompt', 'caption', 'audience', 'status'];
const gitaRow = ['7', 'a still river at dawn', 'Focus — then act', 'Founders', 'Ready'];

describe('extractRow', () => {
  it('recognizes the Corporate schema', () => {
    const f = extractRow(corpHeader, corpRow);
    expect(f.hasSchema).toBe(true);
    expect(f.isReady).toBe(true);
    expect(f.matchColName).toBe('Post #');
    expect(f.matchKey).toBe('12');
    expect(f.imagePrompt).toBe('a calm exec');
    expect(f.headline).toBe('Lead with clarity');
    expect(f.captionFull).toBe('Long LinkedIn body...');
    expect(f.captionShort).toBe('Short punchy body');
    expect(f.lockedSpecs).toBe('specs here');
  });

  it('recognizes the Gita schema', () => {
    const f = extractRow(gitaHeader, gitaRow);
    expect(f.matchColName).toBe('day');
    expect(f.matchKey).toBe('7');
    expect(f.imagePrompt).toBe('a still river at dawn');
    expect(f.caption).toBe('Focus — then act');
    expect(f.captionFull).toBe('');
    expect(f.audience).toBe('Founders');
  });

  it('flags a non-Ready row', () => {
    const f = extractRow(gitaHeader, ['8', 'x', 'y', 'Founders', 'Posted']);
    expect(f.isReady).toBe(false);
  });
});

describe('composePrompt', () => {
  it('appends locked specs and verbatim headline/subhead', () => {
    const p = composePrompt(extractRow(corpHeader, corpRow));
    expect(p).toContain('a calm exec');
    expect(p).toContain('specs here');
    expect(p).toContain('HEADLINE (render exactly and verbatim): "Lead with clarity"');
    expect(p).toContain('SUBHEAD (render exactly and verbatim): "sub here"');
  });
  it('appends the reviewer note on rework', () => {
    expect(composePrompt({ imagePrompt: 'base' }, 'make it warmer')).toContain('Revision requested: make it warmer');
  });
});

describe('composeCaptions', () => {
  it('builds full (LinkedIn) and short (others) for a structured sheet', () => {
    const { full, short } = composeCaptions(extractRow(corpHeader, corpRow), {});
    expect(full).toBe('Lead with clarity\n\nLong LinkedIn body...\n\n#leadership #gita');
    expect(short).toBe('Short punchy body\n\n#leadership #gita');
    expect(full).not.toBe(short);
  });
  it('uses one humanized caption for a single-caption sheet, with audience prefix', () => {
    const { full, short } = composeCaptions(extractRow(gitaHeader, gitaRow), {});
    expect(full).toBe(short);
    expect(full.startsWith('Founders:')).toBe(true);
    expect(full).not.toMatch(/—/); // humanized (em-dash removed)
  });
  it('appends a CTA link once', () => {
    const { short } = composeCaptions(extractRow(gitaHeader, gitaRow), { ctaLink: 'https://x.com/a' });
    expect(short).toContain('https://x.com/a');
    const again = composeCaptions(extractRow(gitaHeader, ['9', 'p', 'c https://x.com/a', 'A', 'Ready']), { ctaLink: 'https://x.com/a' });
    expect((again.short.match(/https:\/\/x\.com\/a/g) || []).length).toBe(1);
  });
});

describe('buildPlatformConfigs', () => {
  it('maps LinkedIn to full and others to short when distinct', () => {
    const cfg = buildPlatformConfigs('FULL', 'SHORT');
    expect(cfg.linkedin.caption).toBe('FULL');
    expect(cfg.facebook.caption).toBe('SHORT');
    expect(cfg.instagram.caption).toBe('SHORT');
  });
  it('returns null when captions are identical', () => {
    expect(buildPlatformConfigs('SAME', 'SAME')).toBeNull();
    expect(buildPlatformConfigs('', '')).toBeNull();
  });
});
