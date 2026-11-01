import { describe, it, expect } from 'vitest';
import {
  pickOldestVideo, sidecarsFor, copyFromCaption, thumbsForAll, istSlot, providerOrder, isCreditError, creditState,
  chooseProvider, laneTwoVerdict, dryTransition, researchPrompt, normalizeResearch, briefTopic, rerunAction,
  nudgeNeeded, laneForInstance, NUDGE_TEXT,
} from '../src/utils/routerSpec.js';

const files = [
  { id: 'v3', name: 'c.mp4', mimeType: 'video/mp4', createdTime: '2026-10-03T00:00:00Z' },
  { id: 'v1', name: 'a.mp4', mimeType: 'video/mp4', createdTime: '2026-10-01T00:00:00Z' },
  { id: 'v2', name: 'POSTED - b.mp4', mimeType: 'video/mp4', createdTime: '2026-09-01T00:00:00Z' },
  { id: 't1', name: 'a.jpg', mimeType: 'image/jpeg', createdTime: '2026-10-01T00:00:00Z' },
  { id: 'c1', name: 'a.txt', mimeType: 'text/plain', createdTime: '2026-10-01T00:00:00Z' },
  { id: 't3', name: 'c.png', mimeType: 'image/png', createdTime: '2026-10-03T00:00:00Z' },
];

describe('Lane 1: pickOldestVideo', () => {
  it('takes the oldest unposted video', () => {
    expect(pickOldestVideo(files).id).toBe('v1');
  });
  it('skips posted and held ids', () => {
    expect(pickOldestVideo(files, ['v1']).id).toBe('v3');
    expect(pickOldestVideo(files, ['v1', 'v3'])).toBeNull();
  });
  it('treats .mp4 names as videos when the mime type is missing', () => {
    expect(pickOldestVideo([{ id: 'x', name: 'clip.MP4' }]).id).toBe('x');
  });
});

describe('Lane 1: sidecarsFor', () => {
  it('finds the same-name thumbnail and caption', () => {
    const s = sidecarsFor(files, files[1]);
    expect(s.thumb.id).toBe('t1');
    expect(s.caption.id).toBe('c1');
  });
  it('a lone thumbnail is not enough', () => {
    const s = sidecarsFor(files, files[0]);
    expect(s.thumb.id).toBe('t3');
    expect(s.caption).toBeNull();
  });
});

describe('Lane 1: copy + slot', () => {
  it('caption file → copy with the first line as title', () => {
    const c = copyFromCaption('﻿Big news\r\n\r\nMore text here');
    expect(c.title).toBe('Big news');
    expect(c.description).toBe('Big news\n\nMore text here');
    expect(c.igCaption).toBe(c.description);
  });
  it('one thumbnail for every platform', () => {
    expect(thumbsForAll('https://x/y.jpg', ['youtube', 'instagram'])).toEqual({ youtube: 'https://x/y.jpg', instagram: 'https://x/y.jpg' });
    expect(thumbsForAll('', ['youtube'])).toEqual({});
  });
  it('future slot → IST dd-MM-yyyy HH:mm; past → "" (post now)', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    expect(istSlot('2026-11-02T02:32:00Z', now)).toBe('02-11-2026 08:02');
    expect(istSlot('2026-11-01T02:32:00Z', now)).toBe('');
  });
});

describe('Lane 2: provider order + credit', () => {
  it('the funnel order first, then the default, then the rest', () => {
    expect(providerOrder('runway, hailuo', 'kling')).toEqual(['runway', 'hailuo', 'kling']);
    expect(providerOrder('', 'hailuo')).toEqual(['hailuo', 'kling', 'runway']);
    expect(providerOrder('bogus', 'nope')).toEqual(['kling', 'runway', 'hailuo']);
  });
  it('spots out-of-credit errors', () => {
    expect(isCreditError('Kling submit failed (429): {"code":1102,"message":"Account balance not enough"}')).toBe(true);
    expect(isCreditError('insufficient_quota')).toBe(true);
    expect(isCreditError('Runway submit failed (400): You do not have enough credits')).toBe(true);
    expect(isCreditError('timeout after 30s')).toBe(false);
  });
  it('credit states', () => {
    expect(creditState({ configured: false }).state).toBe('missing');
    expect(creditState({ configured: true, exhaustedOn: '2026-11-01', today: '2026-11-01' }).state).toBe('exhausted');
    expect(creditState({ configured: true, exhaustedOn: '2026-10-31', today: '2026-11-01', balance: null })).toMatchObject({ ok: true, state: 'unknown' });
    expect(creditState({ configured: true, balance: 0 })).toMatchObject({ ok: false, state: 'empty' });
    expect(creditState({ configured: true, balance: 120 })).toMatchObject({ ok: true, state: 'ok' });
  });
  it('chooses the first provider with credit, in order', () => {
    const states = { kling: { ok: false }, runway: { ok: true }, hailuo: { ok: true } };
    expect(chooseProvider(['kling', 'hailuo', 'runway'], states)).toBe('hailuo');
    expect(chooseProvider(['kling'], states)).toBeNull();
  });
  it('the verdict names what is out', () => {
    const ok = { ok: true };
    const v = laneTwoVerdict({ order: ['kling'], video: { kling: { ok: false } }, deps: { voice: ok, image: ok, llm: { ok: false }, assembly: ok } });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['video (Kling / Runway / Hailuo)', 'LLM']);
    expect(laneTwoVerdict({ order: ['runway'], video: { runway: ok }, deps: { voice: ok, image: ok, llm: ok, assembly: ok } })).toMatchObject({ ok: true, provider: 'runway' });
  });
});

describe('Lane 2: one email per dry spell', () => {
  it('sends on the first dry check only, and resets when credit returns', () => {
    const a = dryTransition({}, false, 't1');
    expect(a).toEqual({ send: true, next: { dry: true, since: 't1' } });
    const b = dryTransition(a.next, false, 't2');
    expect(b.send).toBe(false);
    expect(b.next.since).toBe('t1');
    const c = dryTransition(b.next, true);
    expect(c).toEqual({ send: false, next: { dry: false, since: null } });
    expect(dryTransition(c.next, false, 't3').send).toBe(true);
  });
});

describe('Lane 2: research', () => {
  it('the prompt carries the landing page and the history', () => {
    const { system, user } = researchPrompt({ funnelName: 'Gita', landingUrl: 'https://x.in', landingText: 'Calm mind course', history: ['Old topic'] });
    expect(system).toContain('"Gita"');
    expect(system).toContain('narrator');
    expect(user).toContain('Calm mind course');
    expect(user).toContain('- Old topic');
  });
  it('normalizes the reply and needs a topic', () => {
    expect(normalizeResearch({ topic: '  Fear  ', angle: 'myth', caption: 'Hi' })).toMatchObject({ topic: 'Fear', angle: 'myth', caption: 'Hi' });
    expect(() => normalizeResearch({ angle: 'x' })).toThrow(/no topic/);
  });
  it('the script brief joins topic, angle and format', () => {
    expect(briefTopic({ topic: 'Fear', angle: 'myth vs fact', format: 'list' })).toBe('Fear. Angle: myth vs fact. Format: list');
    expect(briefTopic({ topic: 'Fear' })).toBe('Fear');
  });
});

describe('re-run + nudge', () => {
  it('what a re-run does to the held instance', () => {
    expect(rerunAction(null)).toBe('none');
    expect(rerunAction({ status: 'scheduled', source_type: 'sheet' })).toBe('keep');
    expect(rerunAction({ status: 'failed', source_type: 'sheet' })).toBe('keep');
    expect(rerunAction({ status: 'image_review', source_type: 'sheet' })).toBe('supersede');
    expect(rerunAction({ status: 'script_review', source_type: 'generated' })).toBe('supersede');
    expect(rerunAction({ status: 'video_review', source_type: 'drive_folder' })).toBe('release');
  });
  it('nudges only when a funnel has neither video lane', () => {
    expect(nudgeNeeded([{ readyVideo: true, aiVideo: false }, { readyVideo: false, aiVideo: true }])).toBe(false);
    expect(nudgeNeeded([{ readyVideo: true }, { readyVideo: false, aiVideo: false }])).toBe(true);
    expect(NUDGE_TEXT).toMatch(/^Video lanes are empty\./);
  });
  it('a router ready-video awaiting approval still reads as Lane 1', () => {
    expect(laneForInstance({ status: 'video_review', source_type: 'drive_folder' })).toBe('ready_video');
    expect(laneForInstance({ status: 'script_review', source_type: 'generated' })).toBe('ai_video');
  });
});
