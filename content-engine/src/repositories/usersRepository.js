/**
 * users data access.
 *
 * Purpose:      Manage user identities, roles, plan end dates, last login, and
 *               billing history. Accounts are created on sign-up (future auth);
 *               this repository backs the super-admin Users screen.
 * Responsibility: The only place users / billing_history SQL runs.
 * Dependencies: core/db.
 *
 * The super admin (ganganarayan.rns@gmail.com) is protected from demotion or
 * deletion so the operator cannot lock themselves out.
 */
import { query } from '../core/db.js';

export const SUPER_ADMIN_EMAIL = 'ganganarayan.rns@gmail.com';
export const ROLES = ['user', 'admin', 'super_admin'];

/** List all users (super admin first, then newest). */
export async function list() {
  const { rows } = await query(
    `SELECT email, role, plan_ends_at, last_login_at, created_at
       FROM users
      ORDER BY (role = 'super_admin') DESC, created_at DESC`,
  );
  return rows;
}

export async function findByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  return rows[0] || null;
}

/** Create a user if absent (used by the future sign-up flow). Defaults to 'user'. */
export async function ensure({ email, role = 'user' }) {
  const normalized = String(email).trim().toLowerCase();
  const { rows } = await query(
    `INSERT INTO users (email, role) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING email, role, plan_ends_at, last_login_at, created_at`,
    [normalized, role],
  );
  return rows[0] || findByEmail(normalized);
}

/** Change a user's role. The super admin cannot be demoted. */
export async function setRole(email, role) {
  const normalized = String(email).trim().toLowerCase();
  if (!ROLES.includes(role)) throw new Error('invalid role');
  if (normalized === SUPER_ADMIN_EMAIL && role !== 'super_admin') {
    throw new Error('the super admin cannot be demoted');
  }
  await query('UPDATE users SET role = $2 WHERE email = $1', [normalized, role]);
  return true;
}

/** Set the plan end date. `endsAt` null = forever. */
export async function setPlanEnd(email, endsAt) {
  const normalized = String(email).trim().toLowerCase();
  await query('UPDATE users SET plan_ends_at = $2 WHERE email = $1', [normalized, endsAt]);
  return true;
}

/** Record a login timestamp (called by the future sign-in flow). */
export async function touchLogin(email) {
  const normalized = String(email).trim().toLowerCase();
  await query('UPDATE users SET last_login_at = now() WHERE email = $1', [normalized]);
}

/** Remove a user (never the super admin). */
export async function remove(email) {
  const normalized = String(email).trim().toLowerCase();
  if (normalized === SUPER_ADMIN_EMAIL) return false;
  await query('DELETE FROM users WHERE email = $1', [normalized]);
  return true;
}

/** A user's billing history, newest first. */
export async function billingFor(email) {
  const { rows } = await query(
    `SELECT id, occurred_at, description, amount_inr, status
       FROM billing_history WHERE user_email = $1 ORDER BY occurred_at DESC LIMIT 100`,
    [String(email).toLowerCase()],
  );
  return rows;
}

export default {
  list, findByEmail, ensure, setRole, setPlanEnd, touchLogin, remove, billingFor,
  SUPER_ADMIN_EMAIL, ROLES,
};
