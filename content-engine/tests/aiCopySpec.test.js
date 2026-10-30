import { describe, it, expect } from 'vitest';
import {
  extractAudioArgs,
  copySystemPrompt,
  copyUserPrompt,
  clip,
  normalizeCopy,
  withLink,
  xPost,
  threadsPost,
  platformKey,
  platformConfigsFor,
} from '../src/utils/aiCopySpec.js';

const LINK = 'https://example.com/assess';

describe('extractAudioArgs', () => {
  it('drops video and writes mono mp3', () => {
    const a = extractAudioArgs({ inPath: 'in.mp4', outPath: 'out.mp3' });
    expect(a).toContain('-vn');
    expect(a[a.length - 1]).toBe('out.mp3');
  });
  it('requires both paths', () => {
    expect(() => extractAudioArgs({ inPath: 'x' })).toThrow();
  });
});

describe('prompts', () => {
  it('uses the comment keyword as the IG call to action when set', () => {
    expect(copySystemPrompt({ keyword: 'guide' })).toContain('comment "guide"');
    expect(copySystemPrompt({})).toContain('link in bio');
  });
  it('uses the saved system prompt and always adds the output keys', () => {
    const p = copySystemPrompt({ base: 'House voice only.' });
    expect(p.startsWith('House voice only.')).toBe(true);
    expect(p).toContain('"thumbPrompt"');
  });
  it('falls back to the file name for a silent video', () => {
    expect(copyUserPrompt({ fileName: 'a.mp4' })).toContain('no speech');
    expect(copyUserPrompt({ transcript: 'hello', fileName: 'a.mp4' })).toContain('Transcript:\nhello');
  });
});

describe('clip / normalizeCopy', () => {
  it('cuts at a word boundary with an ellipsis', () => {
    const out = clip('one two three four five', 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith('…')).toBe(true);
  });
  it('strips angle brackets from the title and maps snake_case keys', () => {
    const c = normalizeCopy({ title: '<Hi>', description: 'd', ig_caption: 'ig', short_post: 's', thumb_text: '"Hook" #x', thumb_prompt: 'A lotus' });
    expect(c).toEqual({ title: 'Hi', description: 'd', igCaption: 'ig', short: 's', thumbText: 'Hook x', thumbPrompt: 'A lotus' });
  });
});

describe('links', () => {
  it('appends a link once', () => {
    expect(withLink('body', LINK)).toBe(`body\n\n${LINK}`);
    expect(withLink(`body ${LINK}`, LINK)).toBe(`body ${LINK}`);
  });
  it('keeps X within 280 counting the URL as 23', () => {
    const post = xPost('w '.repeat(300), LINK);
    const textPart = post.split('\n')[0];
    expect(textPart.length + 1 + 23).toBeLessThanOrEqual(280);
    expect(post.endsWith(LINK)).toBe(true);
  });
  it('keeps Threads within 500', () => {
    expect(threadsPost('w '.repeat(400), LINK).length).toBeLessThanOrEqual(500);
  });
});

describe('platformConfigsFor', () => {
  const copy = { title: 'T', description: 'Long', igCaption: 'IG', short: 'Short' };
  it('maps account-map labels', () => {
    expect(platformKey('YouTube')).toBe('youtube');
    expect(platformKey('twitter')).toBe('x');
    expect(platformKey('x')).toBe('x');
    expect(platformKey('facebook_page')).toBe('facebook');
    expect(platformKey('')).toBe('');
  });
  it('gives each platform its own copy, only for the funnel\'s platforms', () => {
    const { caption, platformConfigurations: pc } = platformConfigsFor(copy, {
      accountIds: ['a', 'b', 'c'],
      accountMap: { a: { platform: 'youtube' }, b: { platform: 'instagram' }, c: { platform: 'x' } },
      ctaLink: LINK,
    });
    expect(Object.keys(pc).sort()).toEqual(['instagram', 'x', 'youtube']);
    expect(pc.youtube).toEqual({ title: 'T', caption: `Long\n\n${LINK}` });
    expect(pc.instagram.caption).toBe('IG');
    expect(pc.x.caption).toBe(`Short\n${LINK}`);
    expect(caption).toBe(`Long\n\n${LINK}`);
  });
  it('configures every platform when the account map has no platform info', () => {
    const { platformConfigurations: pc } = platformConfigsFor(copy, { accountIds: ['a'], accountMap: {} });
    expect(Object.keys(pc)).toEqual(expect.arrayContaining(['youtube', 'linkedin', 'facebook', 'instagram', 'threads', 'x']));
  });
});

import { stripTrailingLink, platformConfigsFor as pcf } from '../src/utils/aiCopySpec.js';

describe('CTA: funnel default, post override, never twice', () => {
  it('drops an old baked-in link before adding the right one', () => {
    expect(stripTrailingLink('Body text\n\nhttps://gita.example/a')).toBe('Body text');
    expect(stripTrailingLink('See https://x.y inside')).toBe('See https://x.y inside');
    const out = pcf({ title: 't', description: 'Body\n\nhttps://gita.example/a', igCaption: 'i', short: 's' }, { ctaLink: 'https://corp.example/b' });
    expect(out.caption).toBe('Body\n\nhttps://corp.example/b');
  });
});
