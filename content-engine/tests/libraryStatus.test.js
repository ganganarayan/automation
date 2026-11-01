import { describe, it, expect } from 'vitest';
import { libraryStatus, statusesFor, statusText, NEEDS_YOU_STATUSES, LIBRARY_LABELS } from '../src/utils/libraryStatus.js';

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
