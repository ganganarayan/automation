/**
 * Access service.
 *
 * Purpose:      Guard the dashboard and config pages without ever exposing the
 *               access key in a URL. The key is entered once on the sign-in
 *               screen; the server then sets a signed, httpOnly cookie and all
 *               subsequent requests authenticate via that cookie.
 * Responsibility:
 *               - resolve the required key (DB-managed, env fallback).
 *               - verify a request via cookie (UI) or header/query (API/curl).
 *               - mint/clear the access cookie.
 * Dependencies: tenantConfigRepository, settings, crypto.
 *
 * Password/login is still a later phase; this key is the interim guard.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { settings } from '../settings/index.js';

export const ACCESS_KEY_STORE = { tenant: 'default', key: 'access_key' };
const COOKIE = 'ce_access';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** The currently-required access key ('' means open). */
export async function requiredKey() {
  let dbKey = null;
  try {
    dbKey = await tenantConfig.get(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
  } catch {
    dbKey = null;
  }
  return dbKey || settings.auth.adminKey || '';
}

/** Cookie token = HMAC(app secret, required key). Verifiable, never the raw key. */
function tokenFor(required) {
  return createHmac('sha256', settings.app.secret || 'dev').update(`access:${required}`).digest('hex');
}

function safeEq(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** True if the request is authorized (cookie, or header/query for API use). */
export async function keyOk(req) {
  const required = await requiredKey();
  if (!required) return true; // open until an access key is set

  const cookie = parseCookies(req)[COOKIE];
  if (cookie && safeEq(cookie, tokenFor(required))) return true;

  const provided = req.query?.key || req.headers?.['x-admin-key'] || (req.body && req.body.key);
  return !!(provided && safeEq(provided, required));
}

/** Verify a raw key (used by the sign-in POST). */
export async function verifyKey(provided) {
  const required = await requiredKey();
  return !!(required && safeEq(provided, required));
}

/** Set the signed, httpOnly access cookie. */
export async function setAccessCookie(res) {
  const required = await requiredKey();
  if (!required) return;
  res.cookie(COOKIE, tokenFor(required), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

/** Clear the access cookie (sign out). */
export function clearAccessCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export default { requiredKey, keyOk, verifyKey, setAccessCookie, clearAccessCookie, ACCESS_KEY_STORE };
