import { describe, it, expect } from 'vitest';
import { cancelProblem, exitLink, validExitUrl } from '../src/utils/cancelSpec.js';
import { planBody } from '../src/utils/planPage.js';
import { setupItems, navHtml } from '../src/utils/adminNav.js';
import { refundPage } from '../src/utils/publicPages.js';

const T = { id: 'acme', name: 'Acme', status: 'active', plan: 'growth', parent_id: null, expires_at: '2026-12-10T18:29:59Z', cancelled_at: null };

describe('who may cancel', () => {
  it('a workspace admin of a paying workspace may', () => {
    expect(cancelProblem({ tenant: T, role: 'admin' })).toBe('');
    expect(cancelProblem({ tenant: T, role: 'staff', superAdmin: true })).toBe('');
  });
  it('staff, viewers, client workspaces, the owner and archived workspaces may not', () => {
    expect(cancelProblem({ tenant: T, role: 'staff' })).toMatch(/admin/);
    expect(cancelProblem({ tenant: T, role: 'viewer' })).toMatch(/admin/);
    expect(cancelProblem({ tenant: { ...T, parent_id: 'agency1' } })).toMatch(/agency/);
    expect(cancelProblem({ tenant: { ...T, id: 'default' } })).toMatch(/owner/);
    expect(cancelProblem({ tenant: { ...T, status: 'archived' } })).toMatch(/archived/);
    expect(cancelProblem({ tenant: null })).toBeTruthy();
  });
});

describe('exit assessment link', () => {
  it('adds the workspace id and plan, keeps the owner\'s own query, nothing personal', () => {
    const u = new URL(exitLink('https://assess.example/a/exit?src=app', { tenantId: 'acme', plan: 'growth' }));
    expect(u.searchParams.get('src')).toBe('app');
    expect(u.searchParams.get('tenant')).toBe('acme');
    expect(u.searchParams.get('plan')).toBe('growth');
    expect([...u.searchParams.keys()].sort()).toEqual(['plan', 'src', 'tenant']);
  });
  it('no link or a bad one gives nothing, and only http(s) is saved', () => {
    expect(exitLink('', { tenantId: 'acme' })).toBe('');
    expect(exitLink('javascript:alert(1)', { tenantId: 'acme' })).toBe('');
    expect(validExitUrl('')).toBe(true);
    expect(validExitUrl('https://x.co/e')).toBe(true);
    expect(validExitUrl('ftp://x.co')).toBe(false);
    expect(validExitUrl('not a link')).toBe(false);
  });
});

describe('plan page', () => {
  it('shows one Cancel button for an admin, and Keep my plan once cancelled', () => {
    const open = planBody({ tenant: T, role: 'admin' });
    expect(open).toContain('action="/api/v1/admin/plan/cancel"');
    expect(open).toContain('Cancel my plan');
    expect(open).not.toContain('Keep my plan');
    const done = planBody({ tenant: { ...T, cancelled_at: '2026-11-11T05:00:00Z' }, role: 'admin', flash: 'cancelled' });
    expect(done).toContain('action="/api/v1/admin/plan/resume"');
    expect(done).toContain('Works until');
    expect(done).toContain('You will not be charged again');
    expect(done).not.toContain('plan/cancel');
  });
  it('staff see why, not the button; only the owner sees the exit link box', () => {
    const staff = planBody({ tenant: T, role: 'staff' });
    expect(staff).not.toContain('plan/cancel');
    expect(staff).not.toContain('exit-url');
    expect(planBody({ tenant: { ...T, id: 'default' }, superAdmin: true, base: 'https://x.co/e' })).toContain('value="https://x.co/e"');
  });
  it('escapes the workspace name and has no em dash', () => {
    const h = planBody({ tenant: { ...T, name: '<b>x</b>' }, role: 'admin', superAdmin: true });
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(h).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('menu and policy', () => {
  it('admins get a Plan link; staff do not', () => {
    expect(setupItems({ role: 'admin' }).some((i) => i.id === 'plan')).toBe(true);
    expect(setupItems({ role: 'staff' }).some((i) => i.id === 'plan')).toBe(false);
    expect(navHtml({ current: 'plan', tabs: true })).toContain('href="/api/v1/admin/plan"');
  });
  it('the refund policy names the one-click cancel', () => {
    expect(refundPage()).toContain('Cancel my plan');
    expect(refundPage()).toContain('Keep my plan');
  });
});
