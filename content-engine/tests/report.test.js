import { describe, it, expect } from 'vitest';
import { buildGitaReport, buildVidapulseReport } from '../src/utils/report.js';

const expected = [
  { account_id: 'a1', account_name: 'FB', platform: 'facebook' },
  { account_id: 'a2', account_name: 'IG', platform: 'instagram' },
];

describe('buildGitaReport', () => {
  it('reports all-ok', () => {
    const rows = [
      { account_id: 'a1', success: true },
      { account_id: 'a2', success: true },
    ];
    const r = buildGitaReport(rows, expected);
    expect(r.allOk).toBe(true);
    expect(r.subject).toBe('Gita post live 2/2');
  });
  it('reports partial with failure detail', () => {
    const rows = [
      { account_id: 'a1', success: true },
      { account_id: 'a2', success: false, error: 'token expired' },
    ];
    const r = buildGitaReport(rows, expected);
    expect(r.allOk).toBe(false);
    expect(r.subject).toContain('warning');
    expect(r.body).toContain('token expired');
  });
  it('marks a missing account', () => {
    const r = buildGitaReport([{ account_id: 'a1', success: true }], expected);
    expect(r.body).toContain('MISSING');
  });
  it('handles zero rows', () => {
    const r = buildGitaReport([], expected);
    expect(r.empty).toBe(true);
    expect(r.subject).toBe('No Gita delivery report today');
  });
});

describe('buildVidapulseReport', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  it('flags staleness beyond 26h', () => {
    const rows = [{ post_id: 'p1', platform: 'instagram', success: true, created_at: '2026-07-09T00:00:00Z' }];
    const r = buildVidapulseReport(rows, expected, now, 26);
    expect(r.stale).toBe(true);
    expect(r.subject).toContain('no new post');
  });
  it('reports the newest post group when fresh', () => {
    const rows = [
      { post_id: 'p2', platform: 'facebook', success: true, created_at: '2026-07-11T11:00:00Z' },
      { post_id: 'p2', platform: 'instagram', success: true, created_at: '2026-07-11T11:00:00Z' },
    ];
    const r = buildVidapulseReport(rows, expected, now, 26);
    expect(r.stale).toBe(false);
    expect(r.subject).toBe('VidaPulse post live 2/2');
  });
});
