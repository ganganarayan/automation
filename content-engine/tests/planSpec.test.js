import { describe, it, expect } from 'vitest';
import { PLANS, limitsFor, overLimit, tenantLive, validTenantId, planLabel } from '../src/utils/planSpec.js';

describe('plans match the pricing plan', () => {
  it('Starter, Growth, Agency limits', () => {
    expect(PLANS.starter).toMatchObject({ priceInr: 2499, funnels: 1, channels: 5, posts: 30, aiVideos: 0, users: 1 });
    expect(PLANS.growth).toMatchObject({ priceInr: 8999, funnels: 3, channels: 6, posts: 90, aiVideos: 4, users: 3 });
    expect(PLANS.agency).toMatchObject({ priceInr: 14999, funnels: 10, channels: 10, posts: 300, aiVideos: null, users: 10 });
  });
  it('an unknown or missing plan is custom (no limits)', () => {
    expect(limitsFor('')).toBe(PLANS.custom);
    expect(limitsFor('gold')).toBe(PLANS.custom);
    expect(planLabel('GROWTH')).toBe('Growth');
  });
});

describe('overLimit', () => {
  it('within the plan is fine', () => {
    expect(overLimit('starter', 'posts', 29, 1)).toBe('');
    expect(overLimit('growth', 'funnels', 2, 1)).toBe('');
  });
  it('over the plan says why, in words', () => {
    expect(overLimit('starter', 'posts', 30, 1)).toBe('Your Starter plan allows 30 posts a month. Ask the owner for a bigger plan.');
    expect(overLimit('starter', 'funnels', 1, 1)).toContain('1 funnel.');
    expect(overLimit('starter', 'aiVideos', 0, 1)).toContain('no AI videos');
    expect(overLimit('growth', 'channels', 0, 7)).toContain('6 channels per funnel');
    expect(overLimit('growth', 'posts', 85, 6)).not.toBe('');
  });
  it('unlimited never blocks', () => {
    expect(overLimit('custom', 'posts', 1e6, 1)).toBe('');
    expect(overLimit('agency', 'aiVideos', 500, 1)).toBe('');
  });
});

describe('tenantLive', () => {
  const now = new Date('2026-11-10T06:00:00Z');
  it('active and not expired is live', () => {
    expect(tenantLive({ status: 'active', expires_at: null }, now).live).toBe(true);
    expect(tenantLive({ status: 'active', expires_at: '2026-12-01T00:00:00Z' }, now).live).toBe(true);
  });
  it('expired, suspended or missing is not', () => {
    expect(tenantLive({ status: 'active', expires_at: '2026-11-01T00:00:00Z' }, now)).toEqual({ live: false, reason: 'expired' });
    expect(tenantLive({ status: 'suspended' }, now).live).toBe(false);
    expect(tenantLive(null, now).live).toBe(false);
  });
});

describe('validTenantId', () => {
  it('lower-case letters, digits, dashes; no colon (it splits Post for Me external ids)', () => {
    expect(validTenantId('acme')).toBe(true);
    expect(validTenantId('acme-2')).toBe(true);
    expect(validTenantId('a')).toBe(false);
    expect(validTenantId('Acme')).toBe(false);
    expect(validTenantId('acme:x')).toBe(false);
    expect(validTenantId('-acme')).toBe(false);
  });
});
