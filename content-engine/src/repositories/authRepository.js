/**
 * auth data access.
 *
 * Purpose:      Passwords, lockout counters and sign-in sessions.
 * Responsibility: The only place auth_sessions SQL and the users password
 *               columns are touched.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

const norm = (email) => String(email || '').trim().toLowerCase();

/** The user row with its auth columns, or null. */
export async function findUser(email) {
  const { rows } = await query(
    `SELECT email, role, password_hash, must_change_password, failed_logins, locked_until
       FROM users WHERE email = $1`,
    [norm(email)],
  );
  return rows[0] || null;
}

export async function createSession({ tokenHash, email, mustChange, ttlMs }) {
  await query(
    `INSERT INTO auth_sessions (token_hash, email, must_change, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [tokenHash, norm(email), !!mustChange, String(ttlMs)],
  );
}

/** A live session joined with its user, or null (expired rows are ignored). */
export async function findSession(tokenHash) {
  const { rows } = await query(
    `SELECT s.token_hash, s.email, s.must_change, s.last_seen_at, u.role
       FROM auth_sessions s JOIN users u ON u.email = s.email
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] || null;
}

/** Bump last_seen_at (at most once a minute per session; cheap). */
export async function touchSession(tokenHash) {
  await query(
    `UPDATE auth_sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`,
    [tokenHash],
  );
}

export async function deleteSession(tokenHash) {
  await query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
}

/** Sign the user out everywhere, optionally keeping one session. */
export async function deleteSessionsFor(email, keepTokenHash = null) {
  await query(
    'DELETE FROM auth_sessions WHERE email = $1 AND ($2::text IS NULL OR token_hash <> $2)',
    [norm(email), keepTokenHash],
  );
}

export async function clearMustChange(tokenHash) {
  await query('UPDATE auth_sessions SET must_change = false WHERE token_hash = $1', [tokenHash]);
}

/** Store a new password and clear the lockout + first-time flags. */
export async function setPassword(email, passwordHash) {
  await query(
    `UPDATE users
        SET password_hash = $2, must_change_password = false, password_changed_at = now(),
            failed_logins = 0, locked_until = NULL
      WHERE email = $1`,
    [norm(email), passwordHash],
  );
}

/** Count a failed attempt; lock for `lockMs` once `maxFails` is reached. */
export async function recordFailure(email, maxFails, lockMs) {
  await query(
    `UPDATE users
        SET failed_logins = failed_logins + 1,
            locked_until = CASE WHEN failed_logins + 1 >= $2
                                THEN now() + ($3 || ' milliseconds')::interval
                                ELSE locked_until END
      WHERE email = $1`,
    [norm(email), maxFails, String(lockMs)],
  );
}

export async function recordSuccess(email) {
  await query(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE email = $1',
    [norm(email)],
  );
}

/** Drop expired sessions (called opportunistically on sign-in). */
export async function purgeExpired() {
  await query('DELETE FROM auth_sessions WHERE expires_at <= now()');
}

export default {
  findUser, createSession, findSession, touchSession, deleteSession, deleteSessionsFor,
  clearMustChange, setPassword, recordFailure, recordSuccess, purgeExpired,
};
