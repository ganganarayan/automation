import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { digestAction, digestDay, buildDigest, lowSheets } from '../src/utils/digestSpec.js';
import { reviewLabel } from '../src/utils/stepTimeSpec.js';

const at = (s) => DateTime.fromISO(s, { zone: 'Asia/Kolkata' });
const fmt = (v, { withTime = true } = {}) => (DateTime.isDateTime(v) ? v : DateTime.fromISO(v)).setZone('Asia/Kolkata').toFormat(withTime ? 'dd-MM-yyyy HH:mm' : 'dd-MM-yyyy');

describe('digestAction', () => {
  it('sends the evening email once, and a wake-up after midnight still counts as that evening', () => {
    const evening = at('2026-11-05T20:25');
    expect(digestDay(evening)).toBe('2026-11-05');
    expect(digestAction({ now: evening })).toBe('evening');
    expect(digestAction({ now: evening, eveningOn: '2026-11-05' })).toBe('');
    expect(digestAction({ now: at('2026-11-06T01:00'), eveningOn: '2026-11-05' })).toBe('');
    expect(digestAction({ now: at('2026-11-06T01:00'), eveningOn: '2026-11-04' })).toBe('evening');
  });
  it('sends a morning extra only for an approval the last email did not carry', () => {
    const morning = at('2026-11-06T08:30');
    expect(digestAction({ now: morning, waitingIds: ['a'], sentIds: ['a'] })).toBe('');
    expect(digestAction({ now: morning, waitingIds: ['a', 'b'], sentIds: ['a'] })).toBe('morning');
    expect(digestAction({ now: morning, waitingIds: ['b'], morningOn: '2026-11-06' })).toBe('');
    expect(digestAction({ now: at('2026-11-06T16:05'), waitingIds: ['b'] })).toBe('');
  });
});

describe('buildDigest', () => {
  const now = at('2026-11-05T20:25');
  const base = 'https://app.test';
  const waiting = { id: 1, title: 'Waiting <post>', funnel_name: 'Gita', status: 'image_review', approvalUrl: `${base}/api/v1/review/t` };
  const failed = { id: 2, title: 'Broken', funnel_name: 'HNI', status: 'failed', note: 'Post for Me said no' };
  const posted = { id: 3, title: 'Live', funnel_name: 'VidaPulse', status: 'posted', posted_at: '2026-11-05T02:50:00Z', channels: [{ state: 'ok', platform: 'youtube', name: 'Ganga', url: 'https://y.test/1' }, { state: 'failed', platform: 'x', name: 'G', error: 'nope' }] };

  it('puts every funnel in one email, with the approval link and the channels', () => {
    const { subject, html } = buildDigest({ rows: [posted, failed, waiting], noPost: [{ funnel: 'Assess', reason: 'no rows' }], base, now, fmt });
    expect(subject).toBe('🟡 Daily posts 05-11-2026: 1 to approve, 2 need attention');
    expect(html).toContain('href="https://app.test/api/v1/review/t"');
    expect(html).toContain('Waiting &lt;post&gt;');
    expect(html).toContain('Post for Me said no');
    expect(html).toContain('href="https://y.test/1"');
    expect(html).toContain('(nope)');
    expect(html).toContain('<b>Assess</b>: no rows');
    expect(html).toContain('05-11-2026 08:20');
    for (const name of ['Gita', 'HNI', 'VidaPulse']) expect(html).toContain(name);
  });
  it('the morning extra carries only what waits', () => {
    const { subject, html } = buildDigest({ rows: [waiting, failed, posted], noPost: [{ funnel: 'Assess', reason: 'x' }], base, now, fmt, action: 'morning' });
    expect(subject).toBe('🟡 Morning approvals 05-11-2026: 1 to approve');
    expect(html).not.toContain('Broken');
    expect(html).not.toContain('Assess');
  });
  it('sends nothing when there is nothing to say', () => {
    expect(buildDigest({ rows: [], base, now, fmt })).toBeNull();
    expect(buildDigest({ rows: [posted], base, now, fmt, action: 'morning' })).toBeNull();
  });
  it('the Library says where the link went', () => {
    expect(reviewLabel('review_image', 'digest')).toBe('Image ready, link in the daily email');
  });
});

describe('sheet running out', () => {
  const now = at('2026-11-08T20:30');
  it('picks the sheets with 3 or fewer Ready rows, never an uncounted one', () => {
    const low = lowSheets([
      { id: 'a', name: 'HNI', imagePosts: { count: 2 } },
      { id: 'b', name: 'Kids', imagePosts: { count: 4 } },
      { id: 'c', name: 'Nosheet', imagePosts: { count: null } },
      { id: 'd', name: 'Empty', imagePosts: { count: 0 } },
    ]);
    expect(low.map((s) => s.id)).toEqual(['a', 'd']);
  });
  it('warns in the evening email, and counts it as needing attention', () => {
    const { subject, html } = buildDigest({ lowSheet: [{ funnel: 'HNI', left: 2 }, { funnel: 'Empty', left: 0 }], now, fmt });
    expect(subject).toContain('2 need attention');
    expect(html).toContain('Sheet running out');
    expect(html).toContain('2 Ready rows left, about 2 days');
    expect(html).toContain('no Ready rows left');
  });
  it('is left out of the morning extra', () => {
    expect(buildDigest({ lowSheet: [{ funnel: 'HNI', left: 1 }], now, fmt, action: 'morning' })).toBeNull();
  });
});
