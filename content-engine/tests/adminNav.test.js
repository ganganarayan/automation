import { describe, it, expect } from 'vitest';
import { WORK_ITEMS, setupItems, navHtml, navSlot, fillNav, workItemFor, roleLabel, HOME_PATH } from '../src/utils/adminNav.js';

describe('admin menu', () => {
  it('lists the work pages in order, Today first', () => {
    expect(WORK_ITEMS.map((i) => i.label)).toEqual(['Today', 'Library', 'Calendar', 'Comments', 'Festival post', 'Log and cost']);
    expect(WORK_ITEMS[0].href).toBe(HOME_PATH);
  });

  it('lists setup panels; Tenants only for the super admin; no tracking-bridge', () => {
    expect(setupItems().map((i) => i.label)).toEqual(['Funnels', 'Keys and credit', 'Settings', 'Users', 'Plan']);
    expect(setupItems({ superAdmin: true }).map((i) => i.id)).toEqual(['funnels', 'api-keys', 'content-engine', 'users', 'plan', 'tenants', 'payments']);
    expect(setupItems({ superAdmin: true }).some((i) => i.id === 'tracking-bridge')).toBe(false);
  });

  it('folds Prepare and Instances into Library', () => {
    expect(workItemFor('prepare')).toBe('library');
    expect(workItemFor('instances')).toBe('library');
    const html = navHtml({ current: 'prepare' });
    expect(html).toMatch(/class="nv on" href="\/api\/v1\/admin\/instances"/);
    expect(html).not.toContain('Prepare');
    expect(html).not.toContain('Dashboard');
  });

  it('derives Tenants from a super admin session and shows who is signed in', () => {
    const html = navHtml({ session: { email: 'a@b.c', role: 'super_admin' } });
    expect(html).toContain('#tenants');
    expect(html).toContain('a@b.c');
    expect(html).toContain('super admin');
    expect(navHtml({ session: { email: 'x@y.z', role: 'admin' } })).not.toContain('#tenants');
  });

  it('has exactly one Sign out', () => {
    expect(navHtml().match(/Sign out/g)).toHaveLength(1);
  });

  it('settings page gets tab buttons instead of links', () => {
    const html = navHtml({ tabs: true });
    expect(html).toContain(`onclick="show('api-keys')"`);
    expect(html).not.toContain('/api/v1/admin/settings#');
  });

  it('fills a nav slot with the menu', () => {
    const html = fillNav(`<aside>${navSlot('instances')}</aside>`, { session: { email: 'a@b.c', role: 'admin' } });
    expect(html).not.toContain('<!--admin-nav');
    expect(html).toContain('class="nv on" href="/api/v1/admin/instances"');
    expect(html).toContain('a@b.c');
  });

  it('formats roles for people', () => {
    expect(roleLabel('super_admin')).toBe('super admin');
    expect(roleLabel('')).toBe('');
  });
});
