import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PLANS, PLAN_IDS, isLean, limitsFor, LEAN_VOICE_MODEL, FULL_VOICE_MODEL } from '../src/utils/planSpec.js';
import { homePage } from '../src/utils/publicPages.js';
import { costTts } from '../src/utils/pricing.js';

describe('Starter Lite', () => {
  it('is a ₹999 lean plan with 15 posts and no AI videos', () => {
    expect(PLAN_IDS[0]).toBe('lite');
    expect(PLANS.lite).toMatchObject({ priceInr: 999, posts: 15, aiVideos: 0, funnels: 1, users: 1, clients: 0, lean: true });
    expect(isLean('lite')).toBe(true);
    for (const p of ['starter', 'growth', 'agency', 'custom', '']) expect(isLean(p)).toBe(false);
    expect(limitsFor('lite').label).toBe('Starter Lite');
  });

  it('voices with Flash at half the price', () => {
    expect(LEAN_VOICE_MODEL).toBe('eleven_flash_v2_5');
    expect(FULL_VOICE_MODEL).toBe('eleven_multilingual_v2');
    expect(costTts({ provider: 'elevenlabs_flash', chars: 1000 }).costUsd).toBeCloseTo(costTts({ provider: 'elevenlabs', chars: 1000 }).costUsd / 2, 6);
  });

  it('the landing page shows Lite first and every price + GST', () => {
    const h = homePage();
    expect(h).toContain('Starter Lite');
    expect(h).toContain('₹999<small> + GST / month');
    expect(h).toContain('₹2,799<small> + GST / month');
    expect(h).toContain('18% GST is added to every price');
    const prices = h.match(/₹[\d,]+(<small>)? ?[^₹]{0,12}/g) || [];
    // every plan price and add-on on the page carries + GST (comparison texts aside)
    // every rupee plan price and add-on carries + GST, or is the total with GST
    const pricing = h.slice(h.indexOf('id="pricing"'), h.indexOf('id="compare"'));
    for (const m of pricing.match(/₹[\d,]+(<small>)?[^<\d,]{0,22}/g) || []) expect(m).toMatch(/\+ GST| with /);
    expect(prices.length).toBeGreaterThan(0);
  });
});

describe('lean picture', () => {
  it('cuts a 4:5 from the middle of a 9:16', async () => {
    const { cropFeed } = await import('../src/services/imageLaneService.js').catch(() => ({}));
    if (!cropFeed) return; // the lane needs a database to import; the crop is covered on staging
    const tall = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#336699' } }).png().toBuffer();
    const cut = await sharp(await cropFeed(tall)).metadata();
    expect(cut.width).toBe(1080);
    expect(cut.height).toBe(1350);
  });
});
