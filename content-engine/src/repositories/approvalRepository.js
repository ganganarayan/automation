/**
 * approvals data access.
 *
 * Purpose:      Persist approval requests and their lifecycle so the email
 *               approval + rework loop survives restarts.
 * Responsibility: The only place approvals SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Create a pending approval. `id` is a caller-supplied uuid. */
export async function create({ id, tenantId = 'default', kind, payload }) {
  const { rows } = await query(
    `INSERT INTO approvals (id, tenant_id, kind, payload, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING *`,
    [id, tenantId, kind, payload],
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM approvals WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Atomically mark the token used (single-use). Returns the row if we won. */
export async function consumeToken(id) {
  const { rows } = await query(
    `UPDATE approvals SET token_used = true, updated_at = now()
      WHERE id = $1 AND token_used = false
      RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

export async function setStatus(id, status, note) {
  await query(
    `UPDATE approvals SET status = $2, note = COALESCE($3, note), updated_at = now() WHERE id = $1`,
    [id, status, note ?? null],
  );
}

/** Reset the token so a rework round can re-issue a fresh link on the same row. */
export async function reopenForRework(id, note, payload) {
  await query(
    `UPDATE approvals
        SET status = 'rework', note = $2, payload = COALESCE($3, payload),
            token_used = false, updated_at = now()
      WHERE id = $1`,
    [id, note ?? null, payload ?? null],
  );
}

export async function recent({ tenantId, limit = 50 }) {
  const { rows } = await query(
    `SELECT id, tenant_id, kind, status, note, created_at, updated_at
       FROM approvals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export default { create, findById, consumeToken, setStatus, reopenForRework, recent };
