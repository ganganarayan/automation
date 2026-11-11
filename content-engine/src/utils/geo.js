/**
 * Visitor country and currency, from the IP address.
 *
 * Purpose:      The public pages show one currency, picked from where the
 *               visitor is: rupees (with GST) in India, US dollars elsewhere.
 *               There is no currency switch on the page.
 * Responsibility: client IP -> ISO country -> 'inr' | 'usd'.
 * Dependencies: geoip-country (an offline database: the IP never leaves the server).
 *
 * Order: ?cur=inr|usd (the owner's and QA's own check, not linked anywhere,
 * display only), then the IP lookup. Unknown = usd. Headers are not trusted:
 * a visitor could set one to dodge GST.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let db = null;
function lookup(ip) {
  try {
    if (!db) db = require('geoip-country');
    const hit = db.lookup(ip);
    return hit && hit.country ? String(hit.country).toUpperCase() : '';
  } catch {
    return '';
  }
}

/** The client's IP (Express req.ip honours trust proxy), without the IPv6 prefix. */
export function clientIp(req) {
  const ip = String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
  return ip.replace(/^::ffff:/, '');
}

/** Two-letter country of the visitor ('' = not known). */
export function countryOf(req) {
  const ip = clientIp(req);
  return ip ? lookup(ip) : '';
}

/** 'inr' for India, 'usd' for everyone else (and when not known). */
export function currencyOf(req) {
  const q = String((req && req.query && req.query.cur) || '').toLowerCase();
  if (q === 'inr' || q === 'usd') return q;
  return countryOf(req) === 'IN' ? 'inr' : 'usd';
}

/** Billing country for a checkout: the IP's when known, else what the page showed. */
export function billingCountry(req, fromPage = '') {
  const c = countryOf(req);
  if (c) return c === 'IN' ? 'IN' : 'XX';
  return String(fromPage || '').toUpperCase() === 'IN' ? 'IN' : 'XX';
}

export default { clientIp, countryOf, currencyOf, billingCountry };
