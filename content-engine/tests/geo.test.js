import { describe, it, expect } from 'vitest';
import { countryOf, currencyOf, billingCountry, clientIp } from '../src/utils/geo.js';

const req = (ip, query = {}, headers = {}) => ({ ip, query, get: (n) => headers[n.toLowerCase()] });

describe('currency from the IP', () => {
  it('India pays rupees, everyone else dollars, unknown is dollars', () => {
    expect(countryOf(req('49.36.0.1'))).toBe('IN');
    expect(currencyOf(req('49.36.0.1'))).toBe('inr');
    expect(currencyOf(req('8.8.8.8'))).toBe('usd');
    expect(currencyOf(req('127.0.0.1'))).toBe('usd');
    expect(clientIp(req('::ffff:49.36.0.1'))).toBe('49.36.0.1');
  });
  it('?cur forces the page for checks; a header cannot fake the country', () => {
    expect(currencyOf(req('8.8.8.8', { cur: 'inr' }))).toBe('inr');
    expect(countryOf(req('49.36.0.1', {}, { 'cf-ipcountry': 'US' }))).toBe('IN');
  });
  it('checkout bills by the IP when known, by the page only when not', () => {
    expect(billingCountry(req('49.36.0.1'), 'XX')).toBe('IN');
    expect(billingCountry(req('8.8.8.8'), 'IN')).toBe('XX');
    expect(billingCountry(req('127.0.0.1'), 'IN')).toBe('IN');
  });
});
