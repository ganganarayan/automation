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
  sourceType = null,
  sourceId = null,
  sourceRef = null,
}) {
  const { rows } = await query(
    `INSERT INTO instances (id, tenant_id, funnel_id, funnel_name, title, status, steps, scheduled_for, source_type, source_id, source_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [id, tenantId, funnelId, funnelName, title, status, JSON.stringify(steps), scheduledFor, sourceType, sourceId, sourceRef],
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
            post_status, posted_at, created_at, source_type
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

/** Record the one source this instance came from (fills only what's given). */
export async function setSource(id, { sourceType, sourceId, sourceRef } = {}) {
  const { rowCount } = await query(
    `UPDATE instances
        SET source_type = COALESCE($2, source_type),
            source_id = COALESCE($3, source_id),
            source_ref = COALESCE($4, source_ref),
            updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, sourceType ?? null, sourceId ?? null, sourceRef ?? null],
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

/** Handed to Post for Me: scheduled (still editable) until it really goes out. */
export async function markScheduled(id, { postRefs = [], scheduledFor = null } = {}) {
  const { rowCount } = await query(
    `UPDATE instances
        SET status = 'scheduled', post_status = 'scheduled', post_refs = $2,
            scheduled_for = COALESCE($3, scheduled_for), approved_at = COALESCE(approved_at, now()), updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, JSON.stringify(postRefs), scheduledFor],
  );
  return rowCount > 0;
}

/** Back to an editable draft (its scheduled post was deleted). */
export async function unschedule(id) {
  const { rowCount } = await query(
    `UPDATE instances SET status = 'draft', post_status = 'pending', post_refs = '[]'::jsonb, updated_at = now()
      WHERE id = $1 AND locked = false AND status IN ('scheduled', 'failed')`,
    [id],
  );
  return rowCount > 0;
}

/** Scheduled instances whose time has come (Post for Me should have published them). */
export async function scheduledDue(tenantId = 'default', limit = 25) {
  const { rows } = await query(
    `SELECT * FROM instances
      WHERE tenant_id = $1 AND status = 'scheduled' AND locked = false
        AND (scheduled_for IS NULL OR scheduled_for <= now())
      ORDER BY scheduled_for NULLS FIRST LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
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
 * Is a video (scheduled or posted) already going out for this funnel on this
 * IST date (yyyy-MM-dd)? The sheet image lane skips such days.
 */
export async function videoOnDate(funnelId, dateKey, tenantId = 'default') {
  if (!funnelId || !dateKey) return false;
  const { rows } = await query(
    `SELECT 1 FROM instances
       WHERE tenant_id = $1 AND funnel_id = $2 AND status IN ('scheduled', 'posted')
         AND scheduled_for IS NOT NULL
         AND (scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = $3::date
       LIMIT 1`,
    [tenantId, funnelId, dateKey],
  );
  return rows.length > 0;
}

/**
 * Drive file ids this funnel has already posted or scheduled (the stitch step's video) — how
 * the ready-video lanes hide posted files when they can't rename them in Drive.
 */
export async function postedDriveIds(funnelId, tenantId = 'default') {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT DISTINCT s->'artifacts'->'video'->>'driveId' AS drive_id
       FROM instances, jsonb_array_elements(steps) s
      WHERE tenant_id = $1 AND funnel_id = $2 AND status IN ('posted', 'scheduled')
        AND s->>'key' = 'stitch'`,
    [tenantId, funnelId],
  );
  return rows.map((r) => r.drive_id).filter(Boolean);
}

/**
 * Ready-video work in progress (cleaned, transcribed or AI-drafted, not yet
 * posted) for these Drive files, newest first per file: { driveId: row }.
 */
export async function draftsByDriveIds(funnelId, tenantId = 'default', driveIds = []) {
  if (!funnelId || !driveIds.length) return {};
  const { rows } = await query(
    `SELECT DISTINCT ON (s->'artifacts'->'video'->>'driveId') s->'artifacts'->'video'->>'driveId' AS drive_id, i.*
       FROM instances i, jsonb_array_elements(i.steps) s
      WHERE i.tenant_id = $1 AND i.funnel_id = $2 AND i.status IN ('draft', 'transcript_review') AND i.locked = false
        AND s->>'key' = 'stitch' AND s->'artifacts'->'video'->>'driveId' = ANY($3)
      ORDER BY s->'artifacts'->'video'->>'driveId', i.updated_at DESC`,
    [tenantId, funnelId, driveIds],
  );
  return Object.fromEntries(rows.map((r) => [r.drive_id, r]));
}

export default {
  create, get, list, logRows, saveSteps, setStatus, setMeta, setSource, bumpRound, lockAsPosted, markScheduled, unschedule, scheduledDue, setPostStatus, remove,
  existsForFunnelOnDate, videoOnDate, postedDriveIds, draftsByDriveIds,
};
