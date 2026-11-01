import { describe, it, expect } from 'vitest';
import { signTicket, peekTicket, readTicket, driveAuthUrl, normalizeRepo, dispatchRequest, keepSecFor, normalizeRunner, DRIVE_SCOPE } from '../src/utils/cleanHookSpec.js';

describe('clean job ticket', () => {
  const now = 1_800_000_000_000;
  it('round-trips a payload with the right secret', () => {
    const t = signTicket({ t: 'default', f: 3, d: 'abc' }, 's3cret', now);
    expect(readTicket(t, 's3cret', now + 1000)).toMatchObject({ t: 'default', f: 3, d: 'abc' });
    expect(peekTicket(t).d).toBe('abc');
  });
  it('rejects a wrong secret, a changed payload and an expired ticket', () => {
    const t = signTicket({ d: 'abc' }, 's3cret', now, 60_000);
    expect(readTicket(t, 'other', now)).toBeNull();
    const [, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ d: 'xyz', exp: now + 60_000 })).toString('base64url')}.${sig}`;
    expect(readTicket(forged, 's3cret', now)).toBeNull();
    expect(readTicket(t, 's3cret', now + 61_000)).toBeNull();
    expect(readTicket('', 's3cret', now)).toBeNull();
    expect(readTicket(`${t}.x`, 's3cret', now)).toBeNull();
  });
  it('needs a secret to sign', () => {
    expect(() => signTicket({}, '')).toThrow();
  });
});

describe('drive connect + dispatch', () => {
  it('asks for drive.file offline access', () => {
    const u = new URL(driveAuthUrl({ clientId: 'cid', redirectUri: 'https://x.test/cb', state: 'st' }));
    expect(u.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('redirect_uri')).toBe('https://x.test/cb');
  });
  it('normalizes the repo', () => {
    expect(normalizeRepo('https://github.com/a/b.git')).toBe('a/b');
    expect(normalizeRepo('nope')).toBe('');
  });
  it('builds the workflow_dispatch call', () => {
    const { url, init } = dispatchRequest({ repo: 'a/b', token: 'tok', ref: 'orbitq', hook: 'https://x.test', ticket: 'T' });
    expect(url).toBe('https://api.github.com/repos/a/b/actions/workflows/clean-video.yml/dispatches');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ ref: 'orbitq', inputs: { hook: 'https://x.test', ticket: 'T' } });
    expect(() => dispatchRequest({ repo: 'a/b', token: '' })).toThrow(/GitHub token/);
  });
});

describe('keepSecFor / normalizeRunner', () => {
  it('keeps everything when nothing is cut', () => {
    expect(keepSecFor(100, 0)).toBe(0);
  });
  it('cuts the outro, never below 1 s', () => {
    expect(keepSecFor(100, 6)).toBe(94);
    expect(keepSecFor(3, 6)).toBe(1);
    expect(() => keepSecFor(0, 6)).toThrow();
  });
  it('defaults to railway', () => {
    expect(normalizeRunner('GitHub')).toBe('github');
    expect(normalizeRunner('')).toBe('railway');
    expect(normalizeRunner('x')).toBe('railway');
  });
});
