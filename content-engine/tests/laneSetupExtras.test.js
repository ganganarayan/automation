import { describe, it, expect } from 'vitest';
import { clipSeconds, renderSeconds, klingDuration, runwayDuration, hailuoDuration } from '../src/utils/animationSpec.js';
import { totalClipSeconds, ffmpegConcatArgs } from '../src/utils/stageSpec.js';
import { landingUrls, landingLine, researchPrompt } from '../src/utils/routerSpec.js';
import { voicesErrorText } from '../src/providers/ttsProvider.js';
import { CLIP_SECONDS, WIZARD_STEPS } from '../src/services/videoWizardManifest.js';

describe('clip length 5 to 10 seconds', () => {
  it('clamps the setting to 5..10 (default 5)', () => {
    expect(clipSeconds('7')).toBe(7);
    expect(clipSeconds('3')).toBe(5);
    expect(clipSeconds('15')).toBe(10);
    expect(clipSeconds('')).toBe(5);
    expect(clipSeconds(undefined)).toBe(5);
  });

  it('renders the next size each provider makes', () => {
    expect(renderSeconds('kling', '5')).toBe(5);
    expect(renderSeconds('kling', '7')).toBe(10);
    expect(renderSeconds('runway', '10')).toBe(10);
    expect(renderSeconds('hailuo', '5')).toBe(6);
    expect(renderSeconds('hailuo', '6')).toBe(6);
    expect(renderSeconds('hailuo', '8')).toBe(10);
    expect(klingDuration('8')).toBe('10');
    expect(runwayDuration('6')).toBe(10);
    expect(hailuoDuration('6')).toBe(6);
  });

  it('bills the rendered seconds', () => {
    expect(totalClipSeconds('7', 4, 'kling')).toBe(40);
    expect(totalClipSeconds('5', 4)).toBe(20);
    expect(totalClipSeconds('6', 2, 'hailuo')).toBe(12);
  });

  it('trims each clip to the chosen length when stitching', () => {
    const args = ffmpegConcatArgs({ clipPaths: ['a.mp4', 'b.mp4'], audioPath: 'v.mp3', outPath: 'o.mp4', clipSec: 7 });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]trim=duration=7,setpts=PTS-STARTPTS,scale=');
    expect(graph).toContain('[1:v]trim=duration=7,');
    const plain = ffmpegConcatArgs({ clipPaths: ['a.mp4'], audioPath: 'v.mp3', outPath: 'o.mp4' });
    expect(plain[plain.indexOf('-filter_complex') + 1]).not.toContain('trim=');
  });

  it('offers 5..10 on the Lane 2 page', () => {
    const f = WIZARD_STEPS.find((s) => s.id === 'ai').fields.find((x) => x.key === 'clip_length');
    expect(CLIP_SECONDS).toEqual([5, 6, 7, 8, 9, 10]);
    expect(f.options.map((o) => o.value)).toEqual(['5', '6', '7', '8', '9', '10']);
  });
});

describe('several landing pages', () => {
  it('splits lines, keeps http(s) only, de-dupes', () => {
    expect(landingUrls('https://a.com/x\nhttps://b.com\n\nnot a link\nhttps://a.com/x, http://c.in')).toEqual(['https://a.com/x', 'https://b.com', 'http://c.in']);
    expect(landingUrls('')).toEqual([]);
  });

  it('names one page or lists several in the prompt', () => {
    expect(landingLine('https://a.com')).toBe('Landing page: https://a.com');
    expect(landingLine('https://a.com\nhttps://b.com')).toBe('Landing pages:\n- https://a.com\n- https://b.com');
    expect(landingLine('')).toBe('Landing page: (none set)');
    expect(researchPrompt({ landingUrl: 'https://a.com\nhttps://b.com' }).user).toContain('- https://b.com');
  });
});

describe('voices error text', () => {
  it('explains a restricted key without voices_read', () => {
    const t = voicesErrorText(401, '{"detail":{"status":"missing_permissions","message":"missing the permission voices_read"}}');
    expect(t).toMatch(/Voices: Read/);
    expect(t).toMatch(/voice ID/);
  });
  it('keeps the status for other failures', () => {
    expect(voicesErrorText(401, 'bad key')).toMatch(/401/);
    expect(voicesErrorText(500, 'boom')).toMatch(/500.*boom/);
  });
});

describe('Lane 1 page', () => {
  it('has the Load videos list and stores pasted folder links as IDs', () => {
    const ready = WIZARD_STEPS.find((s) => s.id === 'ready').fields;
    expect(ready.some((f) => f.type === 'ready_videos')).toBe(true);
    expect(ready.find((f) => f.key === 'direct_drive_folder').driveFolder).toBe(true);
  });
});
