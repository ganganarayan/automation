import { describe, it, expect } from 'vitest';
import { libraryStatus, rowStatus, POSTING_STALE_MS, statusesFor, statusText, NEEDS_YOU_STATUSES, LIBRARY_LABELS } from '../src/utils/libraryStatus.js';

describe('library status labels', () => {
  it('maps every raw status to one of seven labels', () => {
    const cases = {
      draft: 'Inbox',
      running: 'Preparing',
      script_review: 'Needs you',
      transcript_review: 'Needs you',
      final_review: 'Needs you',
      manual: 'Needs you',
      image_review: 'Needs you',
      approved: 'Ready',
      ready: 'Ready',
      scheduled: 'Scheduled',
      posted: 'Posted',
      done: 'Posted',
      partial: 'Posted',
      failed: 'Failed',
    };
    for (const [raw, label] of Object.entries(cases)) expect(libraryStatus(raw).label).toBe(label);
    expect(LIBRARY_LABELS).toHaveLength(7);
  });

  it('uses the colour convention', () => {
    expect(libraryStatus('posted').dot).toBe('🟢');
    expect(libraryStatus('transcript_review').dot).toBe('🟡');
    expect(libraryStatus('failed').dot).toBe('🔴');
  });

  it('marks partly posted as attention', () => {
    expect(libraryStatus('partial')).toMatchObject({ key: 'posted', dot: '🟡', note: 'partly' });
    expect(statusText('partial')).toBe('🟡 Posted (partly)');
  });

  it('hides superseded runs and treats unknown statuses as preparing', () => {
    expect(libraryStatus('superseded').hidden).toBe(true);
    expect(libraryStatus('something_new').key).toBe('preparing');
  });

  it('lists raw statuses per label', () => {
    expect(statusesFor('posted').sort()).toEqual(['done', 'partial', 'posted']);
    expect(NEEDS_YOU_STATUSES).toEqual(expect.arrayContaining(['script_review', 'transcript_review', 'final_review', 'manual']));
    expect(NEEDS_YOU_STATUSES).not.toContain('draft');
  });
});

describe('rowStatus (background posts)', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const fresh = new Date(now - 60 * 1000).toISOString();
  it('a post on its way reads as Scheduling / Posting now, under Scheduled', () => {
    expect(rowStatus({ status: 'draft', post_status: 'posting', scheduled_for: '2026-11-02T03:30:00Z', updated_at: fresh }, now))
      .toMatchObject({ key: 'scheduled', label: 'Scheduling', dot: '🔵', posting: true });
    expect(rowStatus({ status: 'draft', post_status: 'posting', scheduled_for: null, updated_at: fresh }, now))
      .toMatchObject({ key: 'scheduled', label: 'Posting now', posting: true });
  });
  it('a post that went quiet, or failed, reads as Failed with the reason', () => {
    const old = new Date(now - POSTING_STALE_MS - 1000).toISOString();
    expect(rowStatus({ status: 'draft', post_status: 'posting', updated_at: old }, now)).toMatchObject({ key: 'failed', dot: '🟡', posting: false });
    expect(rowStatus({ status: 'draft', post_status: 'post_failed', note: 'Post for Me: 401' }, now)).toMatchObject({ key: 'failed', dot: '🔴', note: 'Post for Me: 401' });
  });
  it('otherwise falls back to the raw status', () => {
    expect(rowStatus({ status: 'scheduled', post_status: 'scheduled' }, now)).toMatchObject({ key: 'scheduled', label: 'Scheduled', posting: false });
    expect(rowStatus({ status: 'draft', post_status: 'pending' }, now).label).toBe('Inbox');
  });
});
