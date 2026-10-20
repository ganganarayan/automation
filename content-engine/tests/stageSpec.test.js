import { describe, it, expect } from 'vitest';
import {
  scriptSystemPrompt,
  scriptUserPrompt,
  clampSceneCount,
  splitScriptToScenes,
  sceneImagePrompt,
  aspectToSize,
  totalClipSeconds,
  buildMediaName,
  srtTime,
  buildSrt,
  ffmpegConcatArgs,
} from '../src/utils/stageSpec.js';

describe('script prompts', () => {
  it('system prompt folds in the funnel tone', () => {
    const s = scriptSystemPrompt('Keep it under 60 words. Warm voice.');
    expect(s).toContain('hook');
    expect(s).toContain('Warm voice');
  });
  it('user prompt carries topic, audience and a correction', () => {
    const u = scriptUserPrompt({ topic: 'dharma at work', audience: 'founders', correction: 'punchier hook' });
    expect(u).toContain('dharma at work');
    expect(u).toContain('founders');
    expect(u).toContain('punchier hook');
  });
});

describe('clampSceneCount', () => {
  it('clamps to [1,20] with a fallback', () => {
    expect(clampSceneCount(4)).toBe(4);
    expect(clampSceneCount(0)).toBe(4);
    expect(clampSceneCount(50)).toBe(20);
    expect(clampSceneCount('x', 6)).toBe(6);
  });
});

describe('splitScriptToScenes', () => {
  it('returns exactly count chunks', () => {
    const scenes = splitScriptToScenes('One. Two. Three. Four. Five. Six.', 3);
    expect(scenes).toHaveLength(3);
    expect(scenes.every((s) => s.length > 0)).toBe(true);
  });
  it('pads a short script up to count by reusing the last chunk', () => {
    const scenes = splitScriptToScenes('Only one sentence here.', 4);
    expect(scenes).toHaveLength(4);
    expect(scenes.every((s) => s.length > 0)).toBe(true);
  });
  it('empty script => count empty strings', () => {
    expect(splitScriptToScenes('', 3)).toEqual(['', '', '']);
  });
});

describe('sceneImagePrompt', () => {
  it('prefixes the style', () => {
    expect(sceneImagePrompt('a lake at dawn', 'muted film look')).toBe('muted film look. a lake at dawn');
  });
  it('falls back when both empty', () => {
    expect(sceneImagePrompt('', '')).toBe('cinematic still');
  });
});

describe('aspectToSize', () => {
  it('maps known aspects', () => {
    expect(aspectToSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(aspectToSize('1:1')).toEqual({ width: 1080, height: 1080 });
  });
  it('defaults unknown to 9:16', () => {
    expect(aspectToSize('weird')).toEqual({ width: 1080, height: 1920 });
  });
});

describe('totalClipSeconds', () => {
  it('per-clip length × count', () => {
    expect(totalClipSeconds('5', 4)).toBe(20);
    expect(totalClipSeconds('10', 3)).toBe(30);
    expect(totalClipSeconds('5', 0)).toBe(0);
  });
});

describe('buildMediaName', () => {
  it('sanitizes and appends index + ext', () => {
    expect(buildMediaName('clip', 'abc', 2, 'mp4')).toBe('clip-abc-2.mp4');
    expect(buildMediaName('voice over!', 'z', 0, '.mp3')).toBe('voice-over--z-0.mp3');
  });
});

describe('srtTime / buildSrt', () => {
  it('formats SRT timestamps', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(65.5)).toBe('00:01:05,500');
    expect(srtTime(3661.25)).toBe('01:01:01,250');
  });
  it('builds a numbered SRT body', () => {
    const srt = buildSrt([{ start: 0, end: 2, text: 'Hello' }, { start: 2, end: 4, text: 'World' }]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,000\nHello');
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:04,000\nWorld');
  });
});

describe('ffmpegConcatArgs', () => {
  it('builds a concat + audio-map command for N clips', () => {
    const args = ffmpegConcatArgs({
      clipPaths: ['/t/a.mp4', '/t/b.mp4'],
      audioPath: '/t/v.mp3',
      outPath: '/t/out.mp4',
      width: 1080,
      height: 1920,
    });
    expect(args[0]).toBe('-y');
    // three inputs: two clips + audio
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('concat=n=2:v=1:a=0[v]');
    // audio is input index 2
    expect(args).toContain('2:a');
    expect(args[args.length - 1]).toBe('/t/out.mp4');
  });
  it('burns subtitles when a sub path is given', () => {
    const args = ffmpegConcatArgs({
      clipPaths: ['/t/a.mp4'],
      audioPath: '/t/v.mp3',
      outPath: '/t/out.mp4',
      subPath: '/t/cap.srt',
    });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('concat=n=1:v=1:a=0[vc]');
    expect(fc).toContain('[vc]subtitles=/t/cap.srt[v]');
  });
  it('throws without clips or audio', () => {
    expect(() => ffmpegConcatArgs({ clipPaths: [], audioPath: '/a', outPath: '/o' })).toThrow();
    expect(() => ffmpegConcatArgs({ clipPaths: ['/c'], audioPath: '', outPath: '/o' })).toThrow();
  });
});
