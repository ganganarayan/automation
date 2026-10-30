import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, passwordProblem, newToken, hashToken, safeNext } from '../src/utils/passwordSpec.js';

describe('hashPassword / verifyPassword', () => {
  it('accepts the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('wrong password!', stored)).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same password 1')).not.toBe(await hashPassword('same password 1'));
  });
  it('never throws on a missing or broken hash', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false);
  });
});

describe('passwordProblem', () => {
  it('needs 10+ characters, a match, and not the email', () => {
    expect(passwordProblem('short', 'short')).toMatch(/10/);
    expect(passwordProblem('longenough1', 'longenough2')).toMatch(/match/);
    expect(passwordProblem('a@b.co.in.x', 'a@b.co.in.x', 'A@b.co.in.x')).toMatch(/email/);
    expect(passwordProblem('longenough1', 'longenough1', 'a@b.c')).toBe('');
  });
});

describe('tokens', () => {
  it('stores only a hash of the token', () => {
    const t = newToken();
    expect(t.length).toBeGreaterThan(30);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });
});

describe('safeNext', () => {
  it('keeps own pages and rejects anything off-site', () => {
    expect(safeNext('/api/v1/admin/instances?x=1')).toBe('/api/v1/admin/instances?x=1');
    expect(safeNext('dashboard')).toBe('/api/v1/dashboard');
    expect(safeNext('https://evil.example')).toBe('/api/v1/admin/settings');
    expect(safeNext('//evil.example/api/v1/')).toBe('/api/v1/admin/settings');
    expect(safeNext('/api/v1/admin/login')).toBe('/api/v1/admin/settings');
    expect(safeNext('')).toBe('/api/v1/admin/settings');
  });
});
