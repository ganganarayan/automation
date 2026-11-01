import { describe, it, expect } from 'vitest';
import { cleanVideoArgs, cleanWithCardArgs, subtitlesFilter, parseSrt, splitLongCues, transcriptSrt, clipSrt, captionSampleTimes, captionsVerdict } from '../src/utils/cleanSpec.js';

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello <i>there</i>

2
00:00:05,500 --> 00:00:09,000
second line

3
00:00:09,500 --> 00:00:12,000
in the outro
`;

describe('clean subtitles', () => {
  it('parses SRT and WebVTT timings, skipping cues it cannot read', () => {
    expect(parseSrt(SRT)).toEqual([
      { start: 1, end: 4, text: 'Hello there' },
      { start: 5.5, end: 9, text: 'second line' },
      { start: 9.5, end: 12, text: 'in the outro' },
    ]);
    expect(parseSrt('WEBVTT\r\n\r\n00:01.250 --> 00:02.5 align:start\r\nhi\r\n\r\nnot a cue')).toEqual([{ start: 1.25, end: 2.5, text: 'hi' }]);
    expect(parseSrt('just text')).toEqual([]);
  });

  it('cuts the subtitles at the kept length: later cues dropped, one across the cut ends at it', () => {
    const cues = parseSrt(clipSrt(SRT, 7));
    expect(cues).toEqual([{ start: 1, end: 4, text: 'Hello there' }, { start: 5.5, end: 7, text: 'second line' }]);
    expect(parseSrt(clipSrt(SRT, 0))).toHaveLength(3);
    expect(clipSrt(SRT, 0.5)).toBe('');
    expect(clipSrt('', 10)).toBe('');
  });

  it('splits long cues, sharing the time out by length', () => {
    const long = splitLongCues([{ start: 0, end: 10, text: 'aaaa bbbb cccc dddd' }], 9);
    expect(long.map((c) => c.text)).toEqual(['aaaa bbbb', 'cccc dddd']);
    expect(long[0]).toMatchObject({ start: 0, end: 5 });
    expect(long[1]).toMatchObject({ start: 5, end: 10 });
  });

  it("uses a pasted SRT first, else Whisper's cues, else nothing", () => {
    expect(transcriptSrt({ srt: SRT, cues: [{ start: 0, end: 1, text: 'x' }] })).toBe(SRT);
    expect(parseSrt(transcriptSrt({ srt: '', cues: [{ start: 0, end: 2.5, text: 'whisper' }] }))).toEqual([{ start: 0, end: 2.5, text: 'whisper' }]);
    expect(transcriptSrt({ text: 'edited', cues: [] })).toBe('');
    expect(transcriptSrt(null)).toBe('');
  });

  it('burns them after the zoom, on the video part only', () => {
    const a = cleanVideoArgs({ input: 'i', output: 'o', zoomPct: 10, subPath: 'subs.srt' });
    const vf = a[a.indexOf('-vf') + 1];
    expect(vf.indexOf('subtitles=subs.srt')).toBeGreaterThan(vf.indexOf('crop='));
    const g = cleanWithCardArgs({ input: 'i', card: 'c', output: 'o', zoomPct: 10, cardSec: 4, w: 1080, h: 1920, subPath: 'subs.srt' });
    const graph = g[g.indexOf('-filter_complex') + 1];
    expect(graph).toMatch(/^\[0:v\][^;]*subtitles=subs\.srt[^;]*\[v0\]/);
    expect(graph).toContain('[1:v]scale=1080:1920,setsar=1,fps=30,format=yuv420p[v1]');
    expect(cleanVideoArgs({ input: 'i', output: 'o' }).join(' ')).not.toContain('subtitles');
  });

  it('refuses a subtitle path that would break the filter', () => {
    expect(subtitlesFilter('')).toBe('');
    expect(() => subtitlesFilter("C:\\x's.srt")).toThrow();
  });

  it('samples frames mid-speech, inside the kept part', () => {
    const cues = Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 4, text: `c${i}` }));
    cues.push({ start: 101, end: 101.5, text: 'too short' });
    expect(captionSampleTimes(110, 75, cues)).toEqual([12, 42, 62]);
    expect(captionSampleTimes(0, 0, cues)).toEqual([12, 52, 82]);
    expect(captionSampleTimes(110, 0, [{ start: 3, end: 7, text: 'one' }])).toEqual([5]);
    expect(captionSampleTimes(100, 80, [{ start: 0, end: 0.5, text: 'x' }])).toEqual([20, 40, 60]);
  });

  it('samples 3 frames across the kept part', () => {
    expect(captionSampleTimes(100, 80)).toEqual([20, 40, 60]);
    expect(captionSampleTimes(41)).toEqual([10.3, 20.5, 30.8]);
    expect(captionSampleTimes(0)).toEqual([2, 6, 10]);
  });

  it('calls subtitles present on 2 of 3 frames, not on one title frame', () => {
    expect(captionsVerdict([{ captions: true }, { captions: false }, { captions: true }])).toBe(true);
    expect(captionsVerdict([{ captions: true }, { captions: false }, { captions: false }])).toBe(false);
    expect(captionsVerdict([true])).toBe(true);
    expect(captionsVerdict(undefined)).toBe(false);
  });
});
