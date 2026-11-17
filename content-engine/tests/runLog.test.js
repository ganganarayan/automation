import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../src/core/db.js', () => ({ query: (...args) => query(...args) }));

const { outcomeFor, write, statusChanged } = await import('../src/repositories/runLogRepository.js');
const repo = await import('../src/repositories/instanceRepository.js');

describe('run log: every pass, how it ended and why', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [], rowCount: 1 }); });

  it('a failure keeps its error, a review or post is a success, running ends nothing', () => {
    expect(outcomeFor('failed', 'images: 429')).toEqual({ event: 'failed', detail: 'images: 429' });
    expect(outcomeFor('partial', 'x down')).toEqual({ event: 'failed', detail: 'partly posted: x down' });
    expect(outcomeFor('image_review').event).toBe('success');
    expect(outcomeFor('posted').event).toBe('success');
    expect(outcomeFor('disapproved_hold', 'Disapproved: face').event).toBe('disapproved');
    expect(outcomeFor('running')).toBeNull();
  });

  it('a retry starts the next pass, other events stay in the current one', async () => {
    await write('11111111-1111-1111-1111-111111111111', 'retry', { detail: 'Retry pass 2', by: 'a@b.c' });
    let [sql, p] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO run_log');
    expect(p[1]).toBe('retry');
    expect(p[8]).toBe(1);
    await write('11111111-1111-1111-1111-111111111111', 'failed', { detail: 'boom' });
    [, p] = query.mock.calls[1];
    expect(p[8]).toBe(0);
  });

  it('a failed log write never throws into the run', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(write('11111111-1111-1111-1111-111111111111', 'failed')).resolves.toBeUndefined();
  });

  it('setStatus to failed writes a failed row with the reason', async () => {
    await repo.setStatus('11111111-1111-1111-1111-111111111111', 'failed', 'images: quota');
    const row = query.mock.calls.find(([q]) => q.includes('INSERT INTO run_log'));
    expect(row[1][1]).toBe('failed');
    expect(row[1][2]).toBe('images: quota');
  });

  it('a quiet transition (Remake going back to review) is not logged as a success', async () => {
    await repo.transition('11111111-1111-1111-1111-111111111111', 'disapproved_hold', 'image_review', 'Remake: x', { logOutcome: false });
    expect(query.mock.calls.some(([q]) => q.includes('INSERT INTO run_log'))).toBe(false);
    await statusChanged('11111111-1111-1111-1111-111111111111', 'running');
    expect(query.mock.calls.some(([q]) => q.includes('INSERT INTO run_log'))).toBe(false);
  });
});
