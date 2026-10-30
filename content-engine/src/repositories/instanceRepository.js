/**
 * instances data access.
 *
 * Purpose:      Persist pipeline execution records (one per run) with their
 *               per-step artifacts and real per-step AI costs, so a run survives
 *               restarts and feeds the review + posted-log views.
 * Responsibility: The only place instances SQL runs. A locked instance (posted)
 *               rejects every mutation — enforced in the UPDATE WHERE clause.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

export async function create({
  id,
  tenantId = 'default',
  funnelId = null,
  funnelName = '',
  title = '',
  status = 'script_review',
  steps = [],
  scheduledFor = null,
}) {
  const { rows } = await query(
    `INSERT INTO instances (id, tenant_id, funnel_id, funnel_name, title, status, steps, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, tenantId, funnelId, funnelName, title, status, JSON.stringify(steps), scheduledFor],
  );
  return rows[0];
}

export async function get(id) {
  const { rows } = await query('SELECT * FROM instances WHERE id = $1', [id]);
  return rows[0] || null;
}

/** List instances for a tenant, optionally filtered by status. */
export async function list({ tenantId = 'default', status = null, limit = 100 }) {
  if (status) {
    const { rows } = await query(
      'SELECT * FROM instances WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3',
      [tenantId, status, limit],
    );
    return rows;
  }
  const { rows } = await query(
    'SELECT * FROM instances WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [tenantId, limit],
  );
  return rows;
}

/** Compact rows for the posted log / instances table. */
export async function logRows({ tenantId = 'default', limit = 200 }) {
  const { rows } = await query(
    `SELECT id, title, funnel_name, status, duration_seconds, cost_usd,
            post_status, posted_at, created_at
       FROM instances WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** Replace the steps JSONB and the denormalized cost total. No-op if locked. */
export async function saveSteps(id, steps, costUsd) {
  const { rowCount } = await query(
    `UPDATE instances SET steps = $2, cost_usd = $3, updated_at = now()
       WHERE id = $1 AND locked = false`,
    [id, JSON.stringify(steps), costUsd],
  );
  return rowCount > 0;
}

export async function setStatus(id, status, note) {
  const { rowCount } = await query(
    `UPDATE instances SET status = $2, note = COALESCE($3, note), updated_at = now()
       WHERE id = $1 AND locked = false`,
    [id, status, note ?? null],
  );
  return rowCount > 0;
}

export async function setMeta(id, { title, durationSeconds, scheduledFor } = {}) {
  const { rowCount } = await query(
    `UPDATE instances
        SET title = COALESCE($2, title),
            duration_seconds = COALESCE($3, duration_seconds),
            scheduled_for = COALESCE($4, scheduled_for),
            updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, title ?? null, durationSeconds ?? null, scheduledFor ?? null],
  );
  return rowCount > 0;
}

export async function bumpRound(id) {
  const { rows } = await query(
    `UPDATE instances SET round = round + 1, updated_at = now()
       WHERE id = $1 AND locked = false RETURNING round`,
    [id],
  );
  return rows[0]?.round ?? null;
}

/** Approve + post + lock in one transition. */
export async function lockAsPosted(id, { postRefs = [], postedAt = new Date() } = {}) {
  const { rowCount } = await query(
    `UPDATE instances
        SET status = 'posted', post_status = 'posted', locked = true,
            post_refs = $2, approved_at = COALESCE(approved_at, now()),
            posted_at = $3, updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, JSON.stringify(postRefs), postedAt],
  );
  return rowCount > 0;
}

export async function setPostStatus(id, postStatus) {
  await query('UPDATE instances SET post_status = $2, updated_at = now() WHERE id = $1', [id, postStatus]);
}

/** Delete an instance. A locked (posted) instance is never deleted. */
export async function remove(id) {
  const { rowCount } = await query('DELETE FROM instances WHERE id = $1 AND locked = false', [id]);
  return rowCount > 0;
}

/**
 * Idempotency guard for scheduled runs: is there already a LIVE instance for this
 * funnel whose scheduled_for falls on the given IST date (yyyy-MM-dd)? "Live"
 * excludes only the dead-ends (failed / superseded) — a posted instance counts,
 * since a post already exists for that date and must not be created twice.
 * scheduled_for is a timestamptz; AT TIME ZONE converts it to the IST wall-clock
 * date before comparison.
 */
export async function existsForFunnelOnDate(funnelId, dateKey, tenantId = 'default') {
  if (!funnelId || !dateKey) return false;
  const { rows } = await query(
    `SELECT 1 FROM instances
       WHERE tenant_id = $1 AND funnel_id = $2
         AND status NOT IN ('failed', 'superseded')
         AND scheduled_for IS NOT NULL
         AND (scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = $3::date
       LIMIT 1`,
    [tenantId, funnelId, dateKey],
  );
  return rows.length > 0;
}

/**
 * Drive file ids this funnel has already posted (the stitch step's video) — how
 * the ready-video lanes hide posted files when they can't rename them in Drive.
 */
export async function postedDriveIds(funnelId, tenantId = 'default') {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT DISTINCT s->'artifacts'->'video'->>'driveId' AS drive_id
       FROM instances, jsonb_array_elements(steps) s
      WHERE tenant_id = $1 AND funnel_id = $2 AND status = 'posted'
        AND s->>'key' = 'stitch'`,
    [tenantId, funnelId],
  );
  return rows.map((r) => r.drive_id).filter(Boolean);
}

/**
 * Ready-video AI drafts (unposted generations) for these Drive files, newest
 * first per file: { driveId: row }.
 */
export async function draftsByDriveIds(funnelId, tenantId = 'default', driveIds = []) {
  if (!funnelId || !driveIds.length) return {};
  const { rows } = await query(
    `SELECT DISTINCT ON (s->'artifacts'->'video'->>'driveId') s->'artifacts'->'video'->>'driveId' AS drive_id, i.*
       FROM instances i, jsonb_array_elements(i.steps) s
      WHERE i.tenant_id = $1 AND i.funnel_id = $2 AND i.status = 'draft' AND i.locked = false
        AND s->>'key' = 'stitch' AND s->'artifacts'->'video'->>'driveId' = ANY($3)
      ORDER BY s->'artifacts'->'video'->>'driveId', i.updated_at DESC`,
    [tenantId, funnelId, driveIds],
  );
  return Object.fromEntries(rows.map((r) => [r.drive_id, r]));
}

export default {
  create, get, list, logRows, saveSteps, setStatus, setMeta, bumpRound, lockAsPosted, setPostStatus, remove,
  existsForFunnelOnDate, postedDriveIds, draftsByDriveIds,
};
