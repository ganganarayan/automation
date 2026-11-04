import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryAction } from '../src/utils/retrySpec.js';

const poolConnect = vi.fn();
vi.mock('pg', () => ({ default: { Pool: class { connect = poolConnect; on() {} } } }));
vi.mock('../src/settings/index.js', () => ({ settings: { database: { url: 'x' } } }));
vi.mock('../src/core/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { query } = await import('../src/core/db.js');

const netErr = () => Object.assign(new Error(''), { code: 'ETIMEDOUT' });
const client = (result) => ({ query: vi.fn(result), release: vi.fn() });

describe('query connection retry', () => {
  beforeEach(() => { poolConnect.mockReset(); });

  it('tries again when connecting times out', async () => {
    const c = client(async () => ({ rows: [1] }));
    poolConnect.mockRejectedValueOnce(netErr()).mockResolvedValueOnce(c);
    await expect(query('SELECT 1')).resolves.toEqual({ rows: [1] });
    expect(poolConnect).toHaveBeenCalledTimes(2);
    expect(c.release).toHaveBeenCalledWith(undefined);
  });

  it('never re-runs a query that itself failed, and drops its client', async () => {
    const err = netErr();
    const c = client(async () => { throw err; });
    poolConnect.mockResolvedValue(c);
    await expect(query('UPDATE x')).rejects.toBe(err);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(c.release).toHaveBeenCalledWith(err);
  });

  it('does not retry a non-network connect error', async () => {
    poolConnect.mockImplementation(async () => { throw new Error('password authentication failed'); });
    await expect(query('SELECT 1')).rejects.toThrow('password');
    expect(poolConnect).toHaveBeenCalledTimes(1);
  });
});

describe('a script review with no script', () => {
  const row = { status: 'script_review', source_type: null };

  it('can be retried', () => {
    expect(retryAction(row, [{ key: 'script', status: 'running' }])).toBe(retryAction({ ...row, status: 'failed' }, [{ key: 'script', status: 'running' }]));
    expect(retryAction(row, [{ key: 'script', status: 'running' }])).not.toBe('');
  });

  it('a real script review is left alone', () => {
    expect(retryAction(row, [{ key: 'script', artifacts: { text: 'hello' } }])).toBe('');
  });
});
