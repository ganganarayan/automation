/**
 * Lead links (pure).
 *
 * Purpose:      Each DM'd lead gets a personal link. Build it, build where it
 *               sends them (the landing page, tagged with their code and UTM
 *               source), and tidy what the landing-page script reports back.
 * Responsibility: Pure logic only (no settings/DB/I/O).
 */

const CODE_RE = /^[a-z0-9]{6,32}$/;

export function validCode(code) {
  return CODE_RE.test(String(code || ''));
}

/** The link that goes in their DM ('' when there is nothing to track). */
export function trackedUrl(base, code) {
  const b = String(base || '').replace(/\/+$/, '');
  return b && validCode(code) ? `${b}/api/v1/go/${code}` : '';
}

/**
 * The landing page with ?lc={code} (the page script reads it) and UTM tags,
 * unless the page link already sets them. '' if the target is not http(s).
 */
export function destinationUrl(target, code, { platform = '', lane = '' } = {}) {
  let u;
  try {
    u = new URL(String(target || ''));
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  u.searchParams.set('lc', code);
  const tags = { utm_source: platform || 'instagram', utm_medium: 'dm', utm_campaign: lane || '' };
  for (const [k, v] of Object.entries(tags)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

/** Keep a form submit small and plain: up to 20 short string fields, no passwords or card data. */
export function cleanForm(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const out = {};
  for (const [k, v] of Object.entries(fields).slice(0, 40)) {
    const key = String(k).trim().slice(0, 40);
    if (!key || /pass|card|cvv|cvc|otp|pin|secret|token/i.test(key)) continue;
    if (v === null || typeof v === 'object') continue;
    out[key] = String(v).trim().slice(0, 300);
    if (Object.keys(out).length >= 20) break;
  }
  return Object.keys(out).length ? out : null;
}

export default { validCode, trackedUrl, destinationUrl, cleanForm };
