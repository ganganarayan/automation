import { describe, it, expect } from 'vitest';
import { validCode, trackedUrl, destinationUrl, cleanForm } from '../src/utils/leadLinkSpec.js';

describe('leadLinkSpec', () => {
  it('builds the personal link only for a real code and base', () => {
    expect(trackedUrl('https://app.example.com/', 'ab12cd34ef')).toBe('https://app.example.com/api/v1/go/ab12cd34ef');
    expect(trackedUrl('', 'ab12cd34ef')).toBe('');
    expect(trackedUrl('https://a.b', 'bad code!')).toBe('');
    expect(validCode('ab12cd34ef')).toBe(true);
  });

  it('sends them on with their code and UTM tags, keeping tags the page link already has', () => {
    const u = new URL(destinationUrl('https://lp.example.com/offer?utm_source=reel', 'ab12cd34ef', { platform: 'instagram', lane: 'Vida' }));
    expect(u.searchParams.get('lc')).toBe('ab12cd34ef');
    expect(u.searchParams.get('utm_source')).toBe('reel');
    expect(u.searchParams.get('utm_medium')).toBe('dm');
    expect(u.searchParams.get('utm_campaign')).toBe('Vida');
  });

  it('refuses a target that is not http(s)', () => {
    expect(destinationUrl('javascript:alert(1)', 'ab12cd34ef')).toBe('');
    expect(destinationUrl('not a url', 'ab12cd34ef')).toBe('');
  });

  it('keeps form fields small and drops passwords / card data', () => {
    expect(cleanForm({ name: ' Asha ', phone: '98', password: 'x', card_number: '4111', nested: { a: 1 } })).toEqual({ name: 'Asha', phone: '98' });
    expect(cleanForm(null)).toBe(null);
    expect(cleanForm({ password: 'x' })).toBe(null);
  });
});
