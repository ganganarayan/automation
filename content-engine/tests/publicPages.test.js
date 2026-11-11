import { describe, it, expect } from 'vitest';
import { homePage, privacyPage, termsPage, refundPage, shippingPage, inr, CHANNELS, LOGIN_PATH, UPDATED, STACK_TOTAL } from '../src/utils/publicPages.js';
import { PLANS } from '../src/utils/planSpec.js';

describe('public pages', () => {
  it('home links to sign in and both policies', () => {
    const h = homePage();
    expect(h).toContain(`href="${LOGIN_PATH}"`);
    expect(h).toContain('href="/privacy"');
    expect(h).toContain('href="/terms"');
  });
  it('home sells one plan per funnel and Agency per client, with Indian rupee grouping', () => {
    const h = homePage();
    expect(h).toContain('Always-On Brand');
    expect(h).toContain('₹3,199<small> + GST / month per funnel');
    expect(h).toContain('₹3,999<small> + GST / month per client');
    expect(h).not.toContain('$37<small>');
    const u = homePage({ cur: 'usd' });
    expect(u).toContain('$37<small> / month per funnel');
    expect(u).toContain('$47<small> / month per client');
    expect(u).not.toContain('₹');
    expect(h).toContain('30 finished posts a month');
    expect(h).toContain('10 channels');
    for (const old of ['Starter Lite', 'data-buy="growth"', 'data-buy="solo"', 'Solo']) expect(h).not.toContain(old);
    for (const c of CHANNELS) expect(h).toContain(c);
    expect(h).not.toContain(String.fromCharCode(0x2014));
  });
  it('home has the trust strip, before and after, see it in action, and a yearly price of 10 months for 12', () => {
    const h = homePage();
    expect(h).toContain('Before Content Engine');
    expect(h).toContain('See it in action');
    expect(h).toContain('Cancel any time, one click');
    expect(h).toContain(`₹${inr(Math.round((PLANS.brand.priceInr * 10) / 12))}`);
    expect(h).toContain(`₹${inr(PLANS.brand.priceInr * 10)} + GST a year`);
    expect(h).toContain('class="float-cta"');
  });
  it('+ GST is normal text with the total beside it, and the value stack adds up', () => {
    const h = homePage();
    expect(h).not.toContain('class="gst"');
    expect(h).not.toContain('.gst{');
    expect(h).toContain('₹3,775 a month with 18% GST');
    expect(STACK_TOTAL).toEqual({ inr: 21780, usd: 257 });
    expect(h).toContain('₹21,780+');
    expect(homePage({ cur: 'usd' })).toContain('$257+');
    expect(h).toContain('Founding price');
    expect(h).toContain('Done-with-you setup');
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
  it('refund: no refunds, cancel any time, use until the paid period ends', () => {
    const r = refundPage({ email: 'a@b.co' });
    expect(r).toContain('No refunds');
    expect(r).toContain('Cancel any time');
    expect(r).toContain('until the last day of the period you have already paid for');
    expect(r).toContain('mailto:a@b.co');
    expect(r).toContain(UPDATED);
  });
  it('shipping: digital service, nothing shipped', () => {
    const s = shippingPage();
    expect(s).toContain('Nothing is shipped');
    expect(s).toContain('no shipping or delivery charges');
    expect(s).toContain('the site owner');
  });
  it('every policy page and the home footer link all four policies', () => {
    for (const h of [homePage(), privacyPage(), termsPage(), refundPage(), shippingPage()]) {
      for (const href of ['/privacy', '/terms', '/refund', '/shipping']) expect(h).toContain(`href="${href}"`);
      expect(h).not.toContain(String.fromCharCode(0x2014));
    }
  });
  it('escapes the contact and falls back without one', () => {
    expect(termsPage({ email: '<x>' })).toContain('&lt;x&gt;');
    expect(privacyPage()).toContain('the site owner');
  });
});
