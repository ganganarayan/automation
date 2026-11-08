import { describe, it, expect } from 'vitest';
import {
  LANE_STEPS, timeLane, workLabel, reviewLabel, parseStepLog, stepEvent, formatSpan, buildTimeline, stepTotals, currentStep, LIVE_STEPS_SCRIPT,
} from '../src/utils/stepTimeSpec.js';

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const ev = (k, s, sec, extra = {}) => ({ k, s, at: at(sec), ...extra });
const ai = (extra = {}) => ({ id: 'i', status: 'running', source_type: 'generated', updated_at: at(0), ...extra });
const script = { key: 'script', status: 'done', artifacts: { text: 'hello' } };

describe('festival posts', () => {
  it('follow the image-post steps', () => {
    expect(timeLane({ source_type: 'festival' })).toBe('image');
  });
});

describe('formatSpan', () => {
  it('reads like 1m 20s', () => {
    expect(formatSpan(45000)).toBe('45s');
    expect(formatSpan(80000)).toBe('1m 20s');
    expect(formatSpan(2 * 3600000 + 5 * 60000)).toBe('2h 05m');
    expect(formatSpan(3 * 86400000 + 4 * 3600000)).toBe('3d 4h');
    expect(formatSpan(0)).toBe('0s');
  });

  it('says "-" when the time is unknown', () => {
    expect(formatSpan(null)).toBe('-');
    expect(formatSpan(undefined)).toBe('-');
  });
});

describe('labels per lane', () => {
  it('follows the lane the row is on', () => {
    expect(timeLane({ source_type: 'generated' })).toBe('ai');
    expect(timeLane({ source_type: 'sheet' })).toBe('image');
    expect(timeLane({ source_type: 'drive_folder' })).toBe('ready');
    expect(LANE_STEPS.image).not.toContain('stitch');
    expect(LANE_STEPS.ready).not.toContain('stitch');
    expect(LANE_STEPS.ai).toContain('stitch');
  });

  it('names a step for what it does on that lane', () => {
    expect(workLabel('script')).toBe('Preparing script');
    expect(workLabel('stitch')).toBe('FFmpeg stitching');
    expect(workLabel('transcript', 'ai')).toBe('Transcribing voiceover');
    expect(workLabel('transcript', 'ready')).toBe('Transcribing video');
    expect(workLabel('images', 'image')).toBe('Generating image');
  });

  it('claims an email went out only when one did', () => {
    expect(reviewLabel('review_final', 'sent')).toBe('Final video email sent for approval');
    expect(reviewLabel('review_script', 'failed')).toBe('Script email failed, approve it here');
    expect(reviewLabel('review_image', 'none')).toBe('Image ready, no approval email set');
    expect(reviewLabel('review_script')).toBe('Script ready, waiting for approval');
  });
});

describe('parseStepLog + stepEvent', () => {
  it('survives anything the column holds', () => {
    expect(parseStepLog(null)).toEqual([]);
    expect(parseStepLog('not json')).toEqual([]);
    expect(parseStepLog('[{"k":"script"}]')).toEqual([{ k: 'script' }]);
  });

  it('writes only what it was given', () => {
    expect(stepEvent('script', 'start', { at: at(0) })).toEqual({ k: 'script', s: 'start', at: at(0) });
    expect(stepEvent('review_script', 'start', { at: at(0), email: 'sent' }).email).toBe('sent');
  });
});

describe('buildTimeline + stepTotals', () => {
  const full = [
    ev('script', 'start', 0), ev('script', 'end', 30),
    ev('review_script', 'start', 31, { email: 'sent' }), ev('review_script', 'end', 7231, { by: 'approved' }),
    ev('images', 'start', 7232), ev('images', 'end', 7292),
    ev('stitch', 'start', 7300), ev('stitch', 'end', 7400),
    ev('review_final', 'start', 7401, { email: 'sent' }),
  ];

  it('tells the story in order, with marks', () => {
    const t = buildTimeline(ai({ status: 'final_review' }), [script], full, T0 + 8000 * 1000);
    expect(t.map((e) => e.label)).toEqual([
      'Preparing script', 'Script email sent for approval', 'Script approved', 'Generating images',
      'FFmpeg stitching', 'Final video ready', 'Final video email sent for approval',
    ]);
  });

  it('never counts an approval wait as work', () => {
    const t = buildTimeline(ai({ status: 'final_review' }), [script], full, T0 + 8000 * 1000);
    const totals = stepTotals(t);
    expect(totals.workMs).toBe((30 + 60 + 100) * 1000);
    expect(totals.waitMs).toBe((7200 + (8000 - 7401)) * 1000);
    expect(totals.unknown).toBe(0);
  });

  it('counts every run of a step that ran again', () => {
    const log = [ev('images', 'start', 0), ev('images', 'fail', 10), ev('images', 'start', 20), ev('images', 'end', 50)];
    const t = buildTimeline(ai(), [script], log, T0 + 60000);
    expect(t.filter((e) => e.key === 'images').map((e) => e.state)).toEqual(['failed', 'done']);
    expect(stepTotals(t).workMs).toBe(40000);
  });

  it('clocks a running step, and shows a lost one as unknown, not as hours', () => {
    const log = [ev('images', 'start', 0)];
    const live = buildTimeline(ai(), [script], log, T0 + 90000);
    expect(live.find((e) => e.key === 'images')).toMatchObject({ state: 'running', ms: 90000 });
    const lost = buildTimeline(ai(), [script], log, T0 + 5 * 3600000);
    expect(lost.find((e) => e.key === 'images')).toMatchObject({ state: 'lost', ms: null });
    expect(stepTotals(lost)).toMatchObject({ workMs: 0, unknown: 2 });
  });

  it('a step that started long after the row last changed is not lost', () => {
    const row = { id: 'i', status: 'draft', source_type: 'drive_folder', updated_at: at(-86400) };
    const t = buildTimeline(row, [], [ev('transcript', 'start', 0)], T0 + 60000);
    expect(t[0]).toMatchObject({ label: 'Transcribing video', state: 'running', ms: 60000 });
  });

  it('hides a wait the router passed straight through', () => {
    const row = { id: 'i', status: 'draft', source_type: 'drive_folder', updated_at: at(0) };
    const log = [ev('transcript', 'start', 0), ev('transcript', 'end', 40), ev('review_transcript', 'start', 40), ev('review_transcript', 'end', 41, { by: 'router' })];
    const t = buildTimeline(row, [], log, T0 + 60000);
    expect(t.map((e) => e.key)).toEqual(['transcript']);
  });

  it('marks a change request', () => {
    const log = [ev('review_script', 'start', 0, { email: 'sent' }), ev('review_script', 'end', 60, { by: 'rework' })];
    const t = buildTimeline(ai(), [], log, T0 + 70000);
    expect(t.map((e) => e.label)).toContain('Script sent back for changes');
  });

  it('ignores a repeated end', () => {
    const log = [ev('publish', 'start', 0), ev('publish', 'fail', 5), ev('publish', 'fail', 6)];
    const t = buildTimeline(ai({ status: 'failed' }), [], log, T0 + 60000);
    expect(t.filter((e) => e.key === 'publish')).toHaveLength(1);
  });

  it('an older row uses the steps column and says "-" for the rest', () => {
    const steps = [
      { key: 'script', status: 'done' },
      { key: 'images', status: 'done', startedAt: at(100), finishedAt: at(160) },
      { key: 'animate', status: 'pending' },
      { key: 'publish', status: 'skipped' },
    ];
    const t = buildTimeline(ai({ status: 'failed' }), steps, [], T0 + 200000);
    expect(t.find((e) => e.key === 'script')).toMatchObject({ ms: null, state: 'done' });
    expect(t.find((e) => e.key === 'images')).toMatchObject({ ms: 60000 });
    expect(t.find((e) => e.key === 'animate')).toBeUndefined();
    expect(t.find((e) => e.key === 'publish')).toBeUndefined();
    expect(stepTotals(t)).toMatchObject({ workMs: 60000, unknown: 1 });
  });

  it('does not call a ready video\'s own file a stitch', () => {
    const row = { id: 'i', status: 'posted', source_type: 'drive_folder', updated_at: at(0) };
    const t = buildTimeline(row, [{ key: 'stitch', status: 'done' }, { key: 'script', status: 'done' }], [], T0);
    expect(t.map((e) => e.key)).toEqual(['copy']);
  });

  it('handles a row with nothing at all', () => {
    expect(buildTimeline(null, null, null)).toEqual([]);
    expect(stepTotals(null)).toEqual({ workMs: 0, waitMs: 0, unknown: 0 });
  });
});

describe('currentStep', () => {
  it('names the running step, and keeps polling', () => {
    const cur = currentStep(ai(), [script], [ev('images', 'start', 0)], T0 + 5000);
    expect(cur).toMatchObject({ label: 'Generating images', dot: '🔵', active: true, since: at(0) });
  });

  it('a wait is not active, so the page stops polling', () => {
    const cur = currentStep(ai({ status: 'final_review' }), [script], [ev('review_final', 'start', 0, { email: 'sent' })], T0 + 5000);
    expect(cur).toMatchObject({ label: 'Final video email sent for approval', dot: '🟡', active: false, open: true, key: 'needs_you' });
  });

  it('an older review row makes no claim about email', () => {
    const cur = currentStep(ai({ status: 'final_review' }), [script], [], T0);
    expect(cur.label).toBe('Final video ready, waiting for approval');
  });

  it('script review with no script says so', () => {
    expect(currentStep(ai({ status: 'script_review' }), [], [], T0).label).toBe('No script yet');
  });

  it('works out the step of a running row with no log', () => {
    expect(currentStep(ai(), [], [], T0).label).toBe('Preparing script');
    expect(currentStep(ai(), [script], [], T0).label).toBe('Script approved');
    const upTo = ['images', 'animate'].map((key) => ({ key, status: 'done' }));
    expect(currentStep(ai(), [script, ...upTo], [], T0).label).toBe('Recording voiceover');
    const all = ['images', 'animate', 'voiceover', 'transcript', 'stitch'].map((key) => ({ key, status: 'done' }));
    expect(currentStep(ai(), [script, ...all], [], T0).label).toBe('Final video ready');
    expect(currentStep({ ...ai(), source_type: 'sheet' }, [], [], T0).label).toBe('Generating image');
  });

  it('a running row with no progress reads as stopped, and is not polled', () => {
    const cur = currentStep(ai(), [], [], T0 + 5 * 3600000);
    expect(cur).toMatchObject({ label: 'Stopped at Preparing script', dot: '🟡', active: false, open: false, key: 'preparing' });
  });

  it('a failed row names the step it failed at', () => {
    const cur = currentStep(ai({ status: 'failed' }), [script], [ev('stitch', 'start', 0), ev('stitch', 'fail', 9)], T0 + 60000);
    expect(cur).toMatchObject({ label: 'Failed at FFmpeg stitching', dot: '🔴', key: 'failed', active: false });
  });

  it('settled rows keep their plain label', () => {
    expect(currentStep(ai({ status: 'posted' }), [], [], T0)).toMatchObject({ label: 'Posted', active: false, open: false });
    expect(currentStep(ai({ status: 'scheduled' }), [], [], T0)).toMatchObject({ label: 'Scheduled', active: false });
    expect(currentStep(ai({ status: 'manual' }), [], [], T0)).toMatchObject({ label: 'Needs you', active: false });
  });

  it('a post on its way stays live', () => {
    const cur = currentStep(ai({ status: 'draft', post_status: 'posting' }), [], [], T0);
    expect(cur).toMatchObject({ label: 'Posting now', active: true });
  });

  it('an approved image post is on its way, until it has been quiet too long', () => {
    expect(currentStep(ai({ status: 'approved', source_type: 'sheet' }), [], [], T0)).toMatchObject({ label: 'Approved, sending to Post for Me', active: true });
    expect(currentStep(ai({ status: 'approved', source_type: 'sheet' }), [], [], T0 + 5 * 3600000).active).toBe(false);
  });
});

describe('the live script', () => {
  it('parses, and never polls on its own while hidden', () => {
    expect(() => new Function(LIVE_STEPS_SCRIPT)).not.toThrow();
    expect(LIVE_STEPS_SCRIPT).toContain('document.hidden');
    expect(LIVE_STEPS_SCRIPT).toContain('/api/v1/admin/instances/live');
  });
});
