import { describe, it, expect } from 'vitest';
import { waitStatusOf, isOpen, pendingByInstance, reviewView, approvalButtons, reviewFields, applyReviewEdit } from '../src/utils/approvalButtons.js';

const ap = (kind, payload, extra = {}) => ({ id: 'a1', kind, payload, status: 'pending', token_used: false, created_at: '2026-11-01T00:00:00Z', ...extra });
const inst = (status, extra = {}) => ({ id: 'i1', status, locked: false, post_status: null, ...extra });

describe('approval rows', () => {
  it('maps each kind to the status it waits at', () => {
    expect(waitStatusOf(ap('instance_review', { checkpoint: 'script' }))).toBe('script_review');
    expect(waitStatusOf(ap('instance_review', { checkpoint: 'final' }))).toBe('final_review');
    expect(waitStatusOf(ap('ready_video', {}))).toBe('video_review');
    expect(waitStatusOf(ap('image_post', {}))).toBe('image_review');
    expect(waitStatusOf(ap('gita_image', {}))).toBe('');
    expect(waitStatusOf(null)).toBe('');
  });

  it('is open only while pending and unused', () => {
    expect(isOpen(ap('ready_video', {}))).toBe(true);
    expect(isOpen(ap('ready_video', {}, { token_used: true }))).toBe(false);
    expect(isOpen(ap('ready_video', {}, { status: 'rework' }))).toBe(false);
    expect(isOpen(null)).toBe(false);
  });

  it('keeps the newest open approval per instance', () => {
    const m = pendingByInstance([
      ap('instance_review', { instanceId: 'i1', checkpoint: 'script' }, { id: 'old', created_at: '2026-11-01T00:00:00Z' }),
      ap('instance_review', { instanceId: 'i1', checkpoint: 'script' }, { id: 'new', created_at: '2026-11-02T00:00:00Z' }),
      ap('instance_review', { instanceId: 'i1' }, { id: 'used', created_at: '2026-11-03T00:00:00Z', token_used: true }),
      ap('image_post', { instanceId: 'i2' }, { id: 'img' }),
      ap('gita_image', {}, { id: 'none' }),
    ]);
    expect(m.get('i1').id).toBe('new');
    expect(m.get('i2').id).toBe('img');
    expect(m.size).toBe(2);
  });
});

describe('approvalButtons', () => {
  const script = ap('instance_review', { instanceId: 'i1', checkpoint: 'script' });

  it('shows Review + Approve script on a pending script review', () => {
    const b = approvalButtons(inst('script_review'), script, { canApprove: true });
    expect(b).toMatchObject({ view: 'script', approveLabel: 'Approve script', reviewHref: '/api/v1/admin/instances/i1/review', approveUrl: '/api/v1/admin/instances/i1/approve', videoId: '' });
  });

  it('final review plays the reel and approves to post', () => {
    const fin = ap('instance_review', { instanceId: 'i1', checkpoint: 'final', videoId: 'pay' });
    expect(approvalButtons(inst('final_review'), fin, { canApprove: true })).toMatchObject({ view: 'video', approveLabel: 'Approve & post', videoId: 'pay' });
    expect(approvalButtons(inst('final_review'), fin, { canApprove: true, videoId: 'stitch' }).videoId).toBe('stitch');
  });

  it('shows nothing to a viewer who may not approve', () => {
    expect(approvalButtons(inst('script_review'), script, { canApprove: false })).toBeNull();
    expect(approvalButtons(inst('script_review'), script)).toBeNull();
  });

  it('shows nothing unless the approval is open and matches the instance status', () => {
    expect(approvalButtons(inst('script_review'), null, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('script_review'), { ...script, token_used: true }, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('final_review'), script, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('running'), script, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('script_review', { id: 'other' }), script, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('script_review', { locked: true }), script, { canApprove: true })).toBeNull();
    expect(approvalButtons(inst('video_review', { post_status: 'posting' }), ap('ready_video', { instanceId: 'i1' }), { canApprove: true })).toBeNull();
  });

  it('covers the ready video and image lanes', () => {
    expect(approvalButtons(inst('video_review'), ap('ready_video', { instanceId: 'i1' }), { canApprove: true }).view).toBe('copy');
    expect(approvalButtons(inst('image_review'), ap('image_post', { instanceId: 'i1' }), { canApprove: true }).view).toBe('image');
    expect(reviewView(ap('gita_image', {}))).toBe('');
  });
});

describe('review fields and saving', () => {
  it('script: edits the script text and the payload copy', () => {
    const a = ap('instance_review', { instanceId: 'i1', checkpoint: 'script', scriptText: 'old' });
    expect(reviewFields(a, { text: 'from step' })[0]).toMatchObject({ key: 'text', value: 'from step' });
    expect(reviewFields(a, {})[0].value).toBe('old');
    const e = applyReviewEdit(a, { text: 'from step' }, { text: '  new\r\nline  ' });
    expect(e.artifacts).toEqual({ text: 'new\nline' });
    expect(e.payload).toMatchObject({ instanceId: 'i1', checkpoint: 'script', scriptText: 'new\nline' });
  });

  it('final: nothing to edit', () => {
    const a = ap('instance_review', { checkpoint: 'final' });
    expect(reviewFields(a, {})).toEqual([]);
    expect(applyReviewEdit(a, {}, { text: 'x' })).toBeNull();
  });

  it('ready video: title + description, keeps other copy fields', () => {
    const a = ap('ready_video', { instanceId: 'i1', caption: 'c' });
    const s = { copy: { title: 'T', description: 'D', headline: 'H' } };
    expect(reviewFields(a, s).map((f) => f.key)).toEqual(['title', 'description']);
    const e = applyReviewEdit(a, s, { description: 'New D', ignored: 'x' });
    expect(e.artifacts.copy).toEqual({ title: 'T', description: 'New D', headline: 'H' });
    expect(e.payload.caption).toBe('T\n\nNew D');
    expect(e.payload.ignored).toBeUndefined();
  });

  it('image post: both captions, posted text follows the short one', () => {
    const a = ap('image_post', { instanceId: 'i1', captionFull: 'F', captionShort: 'S' });
    const e = applyReviewEdit(a, { captionFull: 'F', captionShort: 'S' }, { captionFull: 'F2', captionShort: '' });
    expect(e.artifacts).toMatchObject({ captionFull: 'F2', captionShort: '', text: 'F2', copy: { description: 'F2' } });
    expect(e.payload).toMatchObject({ captionFull: 'F2', captionShort: '' });
  });
});
