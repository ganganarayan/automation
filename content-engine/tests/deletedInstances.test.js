import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('../src/core/db.js', () => ({ query: (...args) => query(...args) }));

const { remove, SAMPLE_TITLE } = await import('../src/repositories/instanceRepository.js');
const { costSince } = await import('../src/repositories/workViewRepository.js');

describe('deleting an instance keeps its cost', () => {
  beforeEach(() => query.mockReset());

  it('deletes and logs in one statement, and only an unlocked instance', async () => {
    query.mockResolvedValue({ rows: [{ n: 1 }] });
    await expect(remove('abc')).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('DELETE FROM instances WHERE id = $1 AND locked = false');
    expect(sql).toContain('INSERT INTO deleted_instances');
    expect(params).toEqual(['abc', SAMPLE_TITLE]);
  });

  it('reports false when nothing was deleted', async () => {
    query.mockResolvedValue({ rows: [{ n: 0 }] });
    await expect(remove('locked')).resolves.toBe(false);
  });

  it('counts deleted runs in the monthly cost', async () => {
    query.mockResolvedValue({ rows: [{ total: 3, runs: 2, deleted: 1 }] });
    await expect(costSince({ tenantId: 't', fromUtc: 'x' })).resolves.toEqual({ total: 3, runs: 2, deleted: 1 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM instances');
    expect(sql).toContain('FROM deleted_instances');
    expect(params).toEqual(['t', 'x']);
  });
});
