import { describe, it, expect } from 'vitest';
import { homePage, privacyPage, termsPage, LOGIN_PATH, UPDATED } from '../src/utils/publicPages.js';

describe('public pages', () => {
  it('home links to sign in and both policies', () => {
    const h = homePage();
    expect(h).toContain(`href="${LOGIN_PATH}"`);
    expect(h).toContain('href="/privacy"');
    expect(h).toContain('href="/terms"');
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
