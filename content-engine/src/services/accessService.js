/**
 * Access service.
 *
 * Purpose:      Email + password sign-in for the dashboard and admin pages.
 * Responsibility:
 *               - sign in, sign out, set a new password, reset with the code.
 *               - resolve the signed-in user from the session cookie.
 *               - keyOk(req): the guard every admin page and action calls.
 * Dependencies: authRepository, tenantConfigRepository, passwordSpec, settings.
 *
 * First sign-in: an account with no password yet is claimed with the old
 * access key (if one was ever set) or the reset code; when neither exists, a
 * blank password claims it. A forced "choose your password" popup follows.
 *
 * Locked out: SUPER_ADMIN_RESET_CODE (env, optional) lets the super admin set
 * a new password on /admin/reset. Nothing else depends on an env value; the
 * header x-admin-key (= ADMIN_KEY) still works for curl / machine calls.
 */
import * as auth from '../repositories/authRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { settings } from '../settings/index.js';
import { hashPassword, verifyPassword, passwordProblem, newToken, hashToken, safeEqual } from '../utils/passwordSpec.js';

export const ACCESS_KEY_STORE = { tenant: 'default', key: 'access_key' };
const COOKIE = 'ce_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_FAILS = 5;
const LOCK_MS = 1000 * 60 * 15;
const ADMIN_ROLES = ['admin', 'super_admin'];
const WRONG = 'Wrong email or password.';

/** The old interim access key ('' when none). Only used to claim a first sign-in. */
export async function requiredKey() {
  let dbKey = null;
  try {
    dbKey = await tenantConfig.get(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
  } catch {
    dbKey = null;
  }
  return dbKey || settings.auth.adminKey || '';
}

function resetCode() {
  const code = String(settings.auth.resetCode || '').trim();
  return code.length >= 12 ? code : '';
}

/** True when the lockout reset is switched on (the env code is set). */
export function resetEnabled() {
  return !!resetCode();
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bad cookie */ }
    }
  }
  return out;
}

function tokenHashOf(req) {
  const token = parseCookies(req)[COOKIE];
  return token ? hashToken(token) : null;
}

/** The signed-in session ({ email, role, mustChange, tokenHash }) or null. Cached per request. */
export async function currentSession(req) {
  if (req._session !== undefined) return req._session;
  let session = null;
  const tokenHash = tokenHashOf(req);
  if (tokenHash) {
    try {
      const row = await auth.findSession(tokenHash);
      if (row) {
        session = { email: row.email, role: row.role, mustChange: row.must_change, tokenHash };
        auth.touchSession(tokenHash).catch(() => {});
      }
    } catch {
      session = null;
    }
  }
  req._session = session;
  return session;
}

/** True if the request may use the admin pages and actions. */
export async function keyOk(req) {
  const session = await currentSession(req);
  if (session && !session.mustChange && ADMIN_ROLES.includes(session.role)) return true;
  // Machine / curl access: the same header the /jobs routes accept.
  const header = req.headers?.['x-admin-key'];
  return !!(header && settings.auth.adminKey && safeEqual(header, settings.auth.adminKey));
}

/** 'ok' | 'change' (signed in, must choose a password) | 'login'. */
export async function gateState(req) {
  if (await keyOk(req)) return 'ok';
  const session = await currentSession(req);
  return session && session.mustChange ? 'change' : 'login';
}

async function startSession(res, email, mustChange) {
  const token = newToken();
  await auth.createSession({ tokenHash: hashToken(token), email, mustChange, ttlMs: SESSION_TTL_MS });
  res.cookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_MS, path: '/' });
  auth.purgeExpired().catch(() => {});
}

/**
 * Check an email + password and start a session.
 * @returns {Promise<{ ok: boolean, error?: string, mustChange?: boolean }>}
 */
export async function signIn(res, email, password) {
  const user = await auth.findUser(email);
  if (!user || !ADMIN_ROLES.includes(user.role)) return { ok: false, error: WRONG };
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
    return { ok: false, error: `Too many wrong attempts. Try again in ${mins} min, or use the reset code.` };
  }

  let ok = false;
  let mustChange = !!user.must_change_password;
  if (user.password_hash) {
    ok = await verifyPassword(password, user.password_hash);
  } else if (user.role === 'super_admin') {
    // First sign-in: claim with the old access key or the reset code; with
    // neither in place, a blank password claims it.
    const proofs = [await requiredKey(), resetCode()].filter(Boolean);
    ok = proofs.length ? proofs.some((p) => safeEqual(password, p)) : String(password ?? '') === '';
    mustChange = true;
  } else {
    return { ok: false, error: 'This account has no password yet. Ask the super admin to set it up.' };
  }

  if (!ok) {
    await auth.recordFailure(user.email, MAX_FAILS, LOCK_MS);
    return { ok: false, error: WRONG };
  }
  await auth.recordSuccess(user.email);
  await startSession(res, user.email, mustChange);
  return { ok: true, mustChange };
}

/**
 * Set a new password for the signed-in user (the forced first-time popup, or
 * a normal change). Signs every other browser out.
 */
export async function changePassword(req, { current, password, confirm }) {
  const session = await currentSession(req);
  if (!session) return { ok: false, error: 'Your session expired. Sign in again.' };
  const user = await auth.findUser(session.email);
  if (!user) return { ok: false, error: 'Account not found.' };
  // A normal change (not the forced first-time one) needs the current password.
  if (!session.mustChange && user.password_hash && !(await verifyPassword(current, user.password_hash))) {
    return { ok: false, error: 'Your current password is wrong.' };
  }
  const problem = passwordProblem(password, confirm, user.email);
  if (problem) return { ok: false, error: problem };
  await auth.setPassword(user.email, await hashPassword(password));
  await auth.clearMustChange(session.tokenHash);
  await auth.deleteSessionsFor(user.email, session.tokenHash);
  return { ok: true };
}

// Reset attempts are limited in memory: per IP, and globally, so the code
// cannot be guessed even from many addresses.
const resetTries = new Map();
let globalTries = { count: 0, since: Date.now() };

function resetBlocked(ip) {
  const now = Date.now();
  if (now - globalTries.since > LOCK_MS) globalTries = { count: 0, since: now };
  const t = resetTries.get(ip);
  if (t && now - t.since > LOCK_MS) resetTries.delete(ip);
  const mine = resetTries.get(ip);
  return (mine && mine.count >= MAX_FAILS) || globalTries.count >= MAX_FAILS * 4;
}

function resetFailed(ip) {
  const now = Date.now();
  const t = resetTries.get(ip) || { count: 0, since: now };
  t.count += 1;
  resetTries.set(ip, t);
  globalTries.count += 1;
}

/** Locked out: the env reset code sets a new password for the super admin and signs in. */
export async function resetWithCode(res, ip, { email, code, password, confirm }) {
  const expected = resetCode();
  if (!expected) return { ok: false, error: 'Reset is switched off (no reset code is set on the server).' };
  if (resetBlocked(ip)) return { ok: false, error: 'Too many attempts. Wait 15 minutes.' };
  const user = await auth.findUser(email);
  if (!user || user.role !== 'super_admin' || !safeEqual(code, expected)) {
    resetFailed(ip);
    return { ok: false, error: 'Wrong email or reset code.' };
  }
  const problem = passwordProblem(password, confirm, user.email);
  if (problem) return { ok: false, error: problem };
  await auth.setPassword(user.email, await hashPassword(password));
  await auth.deleteSessionsFor(user.email);
  await auth.recordSuccess(user.email);
  await startSession(res, user.email, false);
  return { ok: true };
}

/** Sign this browser out. */
export async function signOut(req, res) {
  const tokenHash = tokenHashOf(req);
  if (tokenHash) await auth.deleteSession(tokenHash).catch(() => {});
  res.clearCookie(COOKIE, { path: '/' });
}

export default {
  requiredKey, resetEnabled, currentSession, keyOk, gateState, signIn, changePassword, resetWithCode, signOut, ACCESS_KEY_STORE,
};
