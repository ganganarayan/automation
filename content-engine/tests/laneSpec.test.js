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
