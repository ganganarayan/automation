import { describe, it, expect } from 'vitest';
import {
  laneOf, readyStage, canGenerateCopy, isSrt, srtToText, prepareTranscript, glossaryTerms, whisperPrompt,
} from '../src/utils/laneSpec.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Welcome to <i>STHIRA</i>.

2
00:00:03,600 --> 00:00:06,000
Apply Gita Wisdom
every day.
`;

describe('srt', () => {
  it('detects SRT and WebVTT, not plain text', () => {
    expect(isSrt(SRT)).toBe(true);
    expect(isSrt('WEBVTT\n\n00:01.000 --> 00:03.000\nhi')).toBe(true);
    expect(isSrt('Just a transcript at 10:30 today.')).toBe(false);
  });

  it('strips cue numbers, timings and tags', () => {
    expect(srtToText(SRT)).toBe('Welcome to STHIRA. Apply Gita Wisdom every day.');
  });

  it('keeps a number that is part of the speech', () => {
    expect(srtToText('1\n00:00:01,000 --> 00:00:02,000\n108\n\n2\n00:00:02,000 --> 00:00:03,000\nnames')).toBe('108 names');
  });

  it('keeps the raw SRT next to the text', () => {
    expect(prepareTranscript(SRT)).toEqual({ text: 'Welcome to STHIRA. Apply Gita Wisdom every day.', srt: SRT.trim() });
    expect(prepareTranscript('  plain  words ')).toEqual({ text: 'plain words', srt: '' });
  });
});

describe('glossary', () => {
  it('splits lines and commas, dedupes', () => {
    expect(glossaryTerms('STHIRA\nPrATS, Apply Gita Wisdom\nsthira')).toEqual(['STHIRA', 'PrATS', 'Apply Gita Wisdom']);
  });

  it('builds a capped Whisper prompt', () => {
    expect(whisperPrompt('STHIRA, PrATS')).toBe('STHIRA, PrATS.');
    expect(whisperPrompt('')).toBe('');
    expect(whisperPrompt(Array.from({ length: 200 }, (_, i) => `Term${i}`).join('\n')).length).toBeLessThanOrEqual(800);
  });
});

describe('stages', () => {
  const steps = (t = {}, copy = null) => [
    { key: 'transcript', status: t.status || 'pending', artifacts: t.artifacts || {} },
    { key: 'script', status: copy ? 'done' : 'pending', artifacts: copy ? { copy } : {} },
  ];

  it('walks prepare → transcript → copy → review → posted', () => {
    expect(readyStage({ status: 'draft' }, steps())).toBe('prepare');
    expect(readyStage({ status: 'transcript_review' }, steps({ status: 'done', artifacts: { text: 'x' } }))).toBe('transcript');
    expect(readyStage({ status: 'draft' }, steps({ status: 'done', artifacts: { text: 'x', approvedAt: 'now' } }))).toBe('copy');
    expect(readyStage({ status: 'draft' }, steps({ status: 'done', artifacts: { approvedAt: 'now' } }, { title: 't' }))).toBe('review');
    expect(readyStage({ status: 'posted', locked: true }, steps())).toBe('posted');
  });

  it('gates copy on an approved transcript', () => {
    expect(canGenerateCopy(steps({ status: 'done', artifacts: { text: 'x' } }))).toBe(false);
    expect(canGenerateCopy(steps({ status: 'done', artifacts: { text: '', approvedAt: '2026-10-30T00:00:00Z' } }))).toBe(true);
  });

  it('knows the lane', () => {
    expect(laneOf({ source_type: 'drive_folder' })).toBe('ready');
    expect(laneOf({ status: 'manual' })).toBe('generated');
    expect(laneOf({ status: 'transcript_review' })).toBe('ready');
    expect(laneOf({ status: 'final_review' })).toBe('pipeline');
  });
});

import { postOutcome, istToInputValue } from '../src/utils/laneSpec.js';
import { noDashes, normalizeCopy } from '../src/utils/aiCopySpec.js';

describe('scheduled → posted', () => {
  it('is posted only once Post for Me processed it', () => {
    expect(postOutcome({ status: 'scheduled' }, [])).toBe('pending');
    expect(postOutcome({ status: 'processing' }, [])).toBe('pending');
    expect(postOutcome(null)).toBe('pending');
    expect(postOutcome({ status: 'processed' }, [{ success: true }, { success: true }])).toBe('posted');
    expect(postOutcome({ status: 'processed' }, [{ success: true }, { success: false }])).toBe('partial');
    expect(postOutcome({ status: 'processed' }, [{ success: false }])).toBe('failed');
  });
  it('turns DD-MM-YYYY HH:MM into a picker value', () => {
    expect(istToInputValue('30-10-2026 23:30')).toBe('2026-10-30T23:30');
    expect(istToInputValue('tomorrow')).toBe('');
  });
});

describe('no em dashes in copy', () => {
  it('replaces em / en dashes with a comma', () => {
    expect(noDashes('Manifestation stops working — the Gita fixes it')).toBe('Manifestation stops working, the Gita fixes it');
    expect(noDashes('Three days – one shift.')).toBe('Three days, one shift.');
    expect(noDashes('a-b stays')).toBe('a-b stays');
    expect(normalizeCopy({ title: 'Why it fails — and what works', description: 'x', igCaption: 'y', short: 'z' }).title).toBe('Why it fails, and what works');
  });
});

import { mergeChannels, channelOutcome, channelText } from '../src/utils/laneSpec.js';

describe('channels', () => {
  const ch = [{ id: 'a', platform: 'youtube', name: 'G', state: 'waiting' }, { id: 'b', platform: 'x', name: 'GN', state: 'waiting' }];
  it('marks each channel from Post for Me results', () => {
    const m = mergeChannels(ch, { a: { success: true, url: 'https://y' }, b: { success: false, error: 'token expired' } });
    expect(m.map((c) => c.state)).toEqual(['ok', 'failed']);
    expect(channelOutcome(m)).toBe('partial');
    expect(channelText(m[1])).toBe('❌ x GN (token expired)');
    expect(channelOutcome(ch)).toBe('pending');
  });
  it('a retry fixes the failed one without touching the ✅ one', () => {
    const first = mergeChannels(ch, { a: { success: true }, b: { success: false } });
    const retry = first.map((c) => (c.state === 'failed' ? { ...c, state: 'waiting' } : c));
    const after = mergeChannels(retry, { a: { success: false }, b: { success: true } });
    expect(after.map((c) => c.state)).toEqual(['ok', 'ok']);
    expect(channelOutcome(after)).toBe('posted');
  });
});
