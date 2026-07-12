/**
 * Meta CAPI Purchase event builder.
 *
 * Purpose:      Assemble a fully-matched Meta Conversions API Purchase event from
 *               the Razorpay payment plus optional Assess360 enrichment, applying
 *               the fbc/fbp/ip/ua preference ladders and hashing all PII.
 * Responsibility: Pure logic; no I/O — fully unit-testable.
 * Dependencies: hash utils.
 *
 * Preference ladders (first non-empty wins):
 *   fbc:  enrichment.fbc -> reconstructed "fb.1.{fbclid_ts}.{fbclid}" -> notes.fbc
 *   fbp:  enrichment.fbp -> notes.fbp
 *   ip:   enrichment.ip  -> notes.client_ip
 *   ua:   enrichment.ua  -> notes.client_ua
 */
import { hashNormalized, hashPhone, hashedSet } from '../utils/hash.js';

const firstNonEmpty = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '') ?? null;

/** Reconstruct an fbc value from an fbclid if a direct fbc is not available. */
export function reconstructFbc(fbclid, timestampMs = Date.now()) {
  if (!fbclid) return null;
  const seconds = Math.floor(timestampMs / 1000);
  return `fb.1.${seconds}.${fbclid}`;
}

/**
 * Build the CAPI event payload body ({ data: [event] }).
 * @param {object} args
 * @param {object} args.purchase   - { email, phone, amount, paymentId, notes }
 * @param {object} [args.enrichment] - { found, fbclid, fbp, fbc, ip, ua }
 * @param {object} args.config     - { contentName, eventSourceUrl }
 * @param {number} [args.nowMs]
 * @returns {{ event: object, matchSignals: object }}
 */
export function buildPurchaseEvent({ purchase, enrichment = {}, config, nowMs = Date.now() }) {
  const notes = purchase.notes || {};

  const emails = hashedSet([purchase.email, enrichment.email].filter(Boolean), hashNormalized);
  const phones = hashedSet([purchase.phone, enrichment.phone].filter(Boolean), hashPhone);

  const fbc = firstNonEmpty(
    enrichment.fbc,
    enrichment.fbclid ? reconstructFbc(enrichment.fbclid, nowMs) : null,
    notes.fbc,
  );
  const fbp = firstNonEmpty(enrichment.fbp, notes.fbp);
  const ip = firstNonEmpty(enrichment.ip, notes.client_ip);
  const ua = firstNonEmpty(enrichment.ua, notes.client_ua);

  const userData = {};
  if (emails.length) userData.em = emails;
  if (phones.length) userData.ph = phones;
  if (fbc) userData.fbc = fbc;
  if (fbp) userData.fbp = fbp;
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;

  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(nowMs / 1000),
    event_id: purchase.paymentId, // dedup key
    action_source: 'website',
    event_source_url: config.eventSourceUrl,
    user_data: userData,
    custom_data: {
      currency: 'INR',
      value: purchase.amount,
      content_name: config.contentName,
    },
  };

  const matchSignals = {
    email: emails.length > 0,
    phone: phones.length > 0,
    fbp: !!fbp,
    fbc: !!fbc,
    ip: !!ip,
    ua: !!ua,
    assess360: enrichment.found === true,
  };

  return { event, matchSignals };
}

/** Extract normalized purchase fields from a Razorpay payment.captured payload. */
export function extractPurchase(payload) {
  const entity = payload?.payload?.payment?.entity || {};
  const notes = entity.notes || {};
  const amountPaise = Number(entity.amount) || 0;
  return {
    email: entity.email || notes.email || '',
    phone: entity.contact || notes.phone || '',
    amount: Math.round((amountPaise / 100) * 100) / 100,
    paymentId: entity.id || '',
    orderId: entity.order_id || '',
    notes,
  };
}

export default { buildPurchaseEvent, extractPurchase, reconstructFbc };
