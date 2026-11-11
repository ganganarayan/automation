import { describe, it, expect } from 'vitest';
import { homePage, privacyPage, termsPage, inr, CHANNELS, LOGIN_PATH, UPDATED } from '../src/utils/publicPages.js';
import { PLANS } from '../src/utils/planSpec.js';

describe('public pages', () => {
  it('home links to sign in and both policies', () => {
    const h = homePage();
    expect(h).toContain(`href="${LOGIN_PATH}"`);
    expect(h).toContain('href="/privacy"');
    expect(h).toContain('href="/terms"');
  });
  it('home shows every plan from planSpec, with Indian rupee grouping', () => {
    const h = homePage();
    for (const id of ['starter', 'growth', 'agency']) {
      expect(h).toContain(PLANS[id].label);
      expect(h).toContain(`₹${inr(PLANS[id].priceInr)}`);
    }
    expect(h).toContain('30 posts a month');
    expect(h).toContain('No AI videos');
    expect(h).toContain('10 clients, each its own workspace and login');
    for (const c of CHANNELS) expect(h).toContain(c);
    expect(h).not.toContain(String.fromCharCode(0x2014));
  });
  it('home plan buttons mail the contact, or open sign-in without one', () => {
    expect(homePage({ email: 'a@b.co' })).toContain('mailto:a@b.co?subject=');
    expect(homePage()).not.toContain('mailto:');
    expect(homePage({ email: '<x>' })).toContain('&lt;x&gt;');
  });
  it('inr groups the Indian way', () => {
    expect(inr(999)).toBe('999');
    expect(inr(2499)).toBe('2,499');
    expect(inr(14999)).toBe('14,999');
    expect(inr(149999)).toBe('1,49,999');
    expect(inr(12345678)).toBe('1,23,45,678');
  });
  it('privacy names drive.file, Limited Use and the contact', () => {
    const p = privacyPage({ email: 'a@b.co' });
    expect(p).toContain('drive.file');
    expect(p).toContain('Limited Use');
    expect(p).toContain('mailto:a@b.co');
    expect(p).toContain(UPDATED);
    expect(UPDATED).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  });
  it('escapes the contact and falls back without one', () => {
    expect(termsPage({ email: '<x>' })).toContain('&lt;x&gt;');
    expect(privacyPage()).toContain('the site owner');
  });
});
