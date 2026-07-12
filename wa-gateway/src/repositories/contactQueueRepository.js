/**
 * contact_queue data access (Delay Relay intake).
 *
 * Purpose:      Persist validated leads and hand them to the drip sender.
 * Responsibility: The only place contact_queue SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Insert a lead. */
export async function insert({
  tenantId = 'default',
  account,
  contactName,
  contactEmail,
  contactPhone,
  status,
  channels,
  invalidReason,
}) {
  const { rows } = await query(
    `INSERT INTO contact_queue
       (tenant_id, account, contact_name, contact_email, contact_phone, status, channels, invalid_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantId, account, contactName, contactEmail, contactPhone, status, channels, invalidReason],
  );
  return rows[0];
}

/** Bulk insert leads inside a caller-supplied transaction client. */
export async function insertMany(client, rowsIn) {
  let count = 0;
  for (const r of rowsIn) {
    await client.query(
      `INSERT INTO contact_queue
         (tenant_id, account, contact_name, contact_email, contact_phone, status, channels, invalid_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        r.tenantId || 'default', r.account, r.contactName, r.contactEmail,
        r.contactPhone, r.status, r.channels, r.invalidReason,
      ],
    );
    count += 1;
  }
  return count;
}

/** Fetch the oldest N pending leads for an account. */
export async function oldestPending({ tenantId = 'default', account, limit }) {
  const { rows } = await query(
    `SELECT * FROM contact_queue
      WHERE tenant_id = $1 AND account = $2 AND status = 'pending'
      ORDER BY received_at ASC
      LIMIT $3`,
    [tenantId, account, limit],
  );
  return rows;
}

/** Update a lead's terminal status. */
export async function updateStatus(id, { status, channels, invalidReason }) {
  await query(
    `UPDATE contact_queue
        SET status = $2,
            channels = COALESCE($3, channels),
            invalid_reason = COALESCE($4, invalid_reason),
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1`,
    [id, status, channels ?? null, invalidReason ?? null],
  );
}

export default { insert, insertMany, oldestPending, updateStatus };
