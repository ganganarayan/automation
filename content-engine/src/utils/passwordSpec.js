/**
 * Password + session-token helpers (pure).
 *
 * Purpose:      Hash and check passwords, mint session tokens, and decide
 *               whether a new password is acceptable.
 * Responsibility: crypto only. No DB, settings or request access, so it stays
 *               unit-testable.
 * Dependencies: node:crypto (scrypt, randomBytes, sha256).
 *
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64>. The parameters travel with
 * the hash, so they can be raised later without breaking old passwords.
 */
import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 10;

function scryptAsync(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password for storage. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** True when `password` matches a stored hash. Never throws on a bad hash. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scryptAsync(String(password ?? ''), Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Why a new password is not acceptable, or '' when it is.
 * @param {string} password
 * @param {string} confirm
 * @param {string} [email]
 */
export function passwordProblem(password, confirm, email = '') {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw !== String(confirm ?? '')) return 'The two passwords do not match.';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return 'Do not use your email as the password.';
  return '';
}

/** A fresh random session token (goes in the cookie). */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** What the database keeps for a token. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Length-safe constant-time string compare. Empty never matches. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Where to go after sign-in. Only this app's own pages; anything else (an
 * absolute URL, //host, a backslash trick) falls back to the settings page.
 */
export function safeNext(next, fallback = '/api/v1/admin/settings') {
  const s = String(next || '');
  if (s === 'dashboard') return '/api/v1/dashboard';
  if (!s.startsWith('/api/v1/') || s.startsWith('//') || s.includes('\\')) return fallback;
  if (s.startsWith('/api/v1/admin/login') || s.startsWith('/api/v1/admin/logout')) return fallback;
  return s;
}

export default { hashPassword, verifyPassword, passwordProblem, newToken, hashToken, safeEqual, safeNext, MIN_PASSWORD_LENGTH };
