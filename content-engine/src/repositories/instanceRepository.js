/**
 * instances data access.
 *
 * Purpose:      Persist pipeline execution records (one per run) with their
 *               per-step artifacts and real per-step AI costs, so a run survives
 *               restarts and feeds the review + posted-log views.
 * Responsibility: The only place instances SQL runs. A locked instance (posted)
 *               rejects every mutation: enforced in the UPDATE WHERE clause.
 * Dependencies: core/db.
 */
import { randomUUID } from 'node:crypto';
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

/** A few instances by id, for the Library's live step updates. */
export async function byIds({ tenantId = 'default', ids = [] }) {
  if (!ids.length) return [];
  const { rows } = await query('SELECT * FROM instances WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids]);
  return rows;
}

/**
 * Add step log events (atomic: a write to the steps column can't lose them). A locked
 * row still takes them, and updated_at stays, because keeping time is not progress.
 */
export async function appendStepLog(id, events) {
  await query('UPDATE instances SET step_log = step_log || $2::jsonb WHERE id = $1', [id, JSON.stringify(events)]);
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

/**
 * The rows for the daily email: what waits on you or is scheduled, what is being
 * made (a lost run stops showing after 3 days), and whatever else moved today.
 */
export async function digestRows({ tenantId = 'default', statuses = ['script_review', 'transcript_review', 'final_review', 'image_review', 'video_review', 'review', 'manual', 'scheduled'], limit = 100 }) {
  const { rows } = await query(
    `SELECT id, title, funnel_id, funnel_name, status, post_status, note, scheduled_for, posted_at, updated_at, steps
       FROM instances
      WHERE tenant_id = $1 AND status NOT IN ('superseded', 'draft')
        AND (status = ANY($2::text[])
          OR (status = 'running' AND updated_at > now() - interval '3 days')
          OR updated_at > now() - interval '24 hours'
          OR posted_at > now() - interval '24 hours')
      ORDER BY funnel_name, COALESCE(posted_at, scheduled_for, created_at) DESC LIMIT $3`,
    [tenantId, statuses, limit],
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

/**
 * Move from one status to another only if the instance is still in `from`
 * (and unlocked): so a double-clicked approval acts once. True if we won.
 */
export async function transition(id, from, to, note) {
  const { rowCount } = await query(
    `UPDATE instances SET status = $3, note = COALESCE($4, note), updated_at = now()
       WHERE id = $1 AND status = $2 AND locked = false`,
    [id, from, to, note ?? null],
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
export async function markScheduled(id, { postRefs = [], scheduledFor = null, postNow = false } = {}) {
  // Post now: no scheduled time (the posted time comes from Post for Me).
  const { rowCount } = await query(
    `UPDATE instances
        SET status = 'scheduled', post_status = 'scheduled', post_refs = $2,
            scheduled_for = CASE WHEN $4 THEN NULL ELSE COALESCE($3, scheduled_for) END,
            approved_at = COALESCE(approved_at, now()), updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, JSON.stringify(postRefs), scheduledFor, postNow],
  );
  return rowCount > 0;
}

/** Some channels failed: posted where it worked, open for a retry of the rest. */
export async function markPartial(id, { note = null, postedAt = new Date() } = {}) {
  const { rowCount } = await query(
    `UPDATE instances SET status = 'partial', post_status = 'partial', note = COALESCE($2, note), posted_at = $3, updated_at = now()
      WHERE id = $1 AND locked = false`,
    [id, note, postedAt],
  );
  return rowCount > 0;
}

/** Move an unposted instance to another funnel (its saved source belonged to the old one). */
export async function moveFunnel(id, { funnelId, funnelName }) {
  const { rowCount } = await query(
    `UPDATE instances SET funnel_id = $2, funnel_name = $3, source_id = NULL, updated_at = now()
      WHERE id = $1 AND locked = false AND status IN ('draft', 'transcript_review', 'failed')`,
    [id, funnelId, funnelName],
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

/** Ready videos still waiting on Post for Me, soonest first (✂ Fix scheduled videos). */
export async function scheduledReadyVideos(tenantId = 'default', limit = 100) {
  const { rows } = await query(
    `SELECT * FROM instances
      WHERE tenant_id = $1 AND status = 'scheduled' AND locked = false
        AND source_type IN ('drive_folder', 'drive_pick') AND scheduled_for > now()
      ORDER BY scheduled_for LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** Partly posted / failed instances whose next automatic retry is due. */
export async function retryDue(tenantId = 'default', limit = 10) {
  const { rows } = await query(
    `SELECT * FROM instances i
      WHERE tenant_id = $1 AND status IN ('partial', 'failed') AND locked = false
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.steps) s
                     WHERE s->>'key' = 'publish'
                       AND (s->'artifacts'->'retry'->>'nextAt') IS NOT NULL
                       AND (s->'artifacts'->'retry'->>'nextAt')::timestamptz <= now())
      ORDER BY updated_at LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function setPostStatus(id, postStatus) {
  await query('UPDATE instances SET post_status = $2, updated_at = now() WHERE id = $1', [id, postStatus]);
}

/** 📅 / ⚡ pressed: the post is being handed to Post for Me in the background (scheduledFor null = now). */
export async function markPosting(id, { scheduledFor = null } = {}) {
  const { rowCount } = await query(
    `UPDATE instances SET post_status = 'posting', scheduled_for = $2, updated_at = now(),
            note = CASE WHEN post_status = 'post_failed' THEN NULL ELSE note END
      WHERE id = $1 AND locked = false AND status IN ('draft', 'transcript_review', 'video_review')`,
    [id, scheduledFor],
  );
  return rowCount > 0;
}

/** The background post failed before Post for Me took it: the draft stays editable, with the reason. */
export async function markPostFailed(id, error) {
  const { rowCount } = await query(
    `UPDATE instances SET post_status = 'post_failed', note = $2, updated_at = now()
      WHERE id = $1 AND locked = false AND post_status = 'posting'`,
    [id, String(error || 'post failed').slice(0, 500)],
  );
  return rowCount > 0;
}

/** Posted instances with a ✅ channel that has no live link yet (given up on after 3 tries). */
export async function missingLinks(tenantId = 'default', limit = 10) {
  const { rows } = await query(
    `SELECT * FROM instances i
      WHERE tenant_id = $1 AND status IN ('posted', 'partial')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.steps) s,
                                  jsonb_array_elements(s->'artifacts'->'channels') c
                     WHERE s->>'key' = 'publish' AND c->>'state' = 'ok'
                       AND COALESCE(c->>'url', '') = ''
                       AND COALESCE((c->>'linkTries')::int, 0) < 3)
      ORDER BY posted_at DESC NULLS LAST LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** Save fetched links. The one write allowed on a locked instance: a link changes nothing about the post. */
export async function saveLinks(id, steps) {
  await query('UPDATE instances SET steps = $2 WHERE id = $1', [id, JSON.stringify(steps)]);
}

/**
 * One remade attempt into the deleted-runs log, while the run itself goes on.
 * Its cost is 0 here: the costs stay on the run (they add up across attempts),
 * so nothing is counted twice. Steps are kept without their costs, for the record.
 */
export async function logAttempt(row, { title, status = 'disapproved', steps = [] } = {}) {
  await query(
    `INSERT INTO deleted_instances (id, tenant_id, funnel_id, funnel_name, title, status, cost_usd, steps, created_at)
     VALUES ($8, $1, $2, $3, $4, $5, 0, $6, $7)`,
    [row.tenant_id || 'default', row.funnel_id || null, row.funnel_name || '', title || row.title || '', status, JSON.stringify(steps), row.created_at || new Date(), randomUUID()],
  );
}

/** The title of a + Sample instance: its costs are made up, so they never count as spend. */
export const SAMPLE_TITLE = 'SAMPLE: delete me';

/**
 * Delete an instance and log it in one statement, so its cost is never lost.
 * A locked (posted) instance is never deleted.
 */
export async function remove(id) {
  const { rows } = await query(
    `WITH gone AS (
       DELETE FROM instances WHERE id = $1 AND locked = false RETURNING *
     ), logged AS (
       INSERT INTO deleted_instances (id, tenant_id, funnel_id, funnel_name, title, status, cost_usd, steps, created_at)
       SELECT id, tenant_id, funnel_id, funnel_name, title, status,
              CASE WHEN title = $2 THEN 0 ELSE cost_usd END,
              CASE WHEN title = $2 THEN '[]'::jsonb ELSE steps END,
              created_at
         FROM gone
       RETURNING id
     )
     SELECT count(*)::int AS n FROM gone`,
    [id, SAMPLE_TITLE],
  );
  return rows[0].n > 0;
}

/**
 * Idempotency guard for scheduled runs: is there already a LIVE instance for this
 * funnel whose scheduled_for falls on the given IST date (yyyy-MM-dd)? "Live"
 * excludes only the dead-ends (failed / superseded): a posted instance counts,
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
       WHERE tenant_id = $1 AND funnel_id = $2 AND status IN ('scheduled', 'posted', 'partial')
         AND COALESCE(scheduled_for, posted_at) IS NOT NULL
         AND (COALESCE(scheduled_for, posted_at) AT TIME ZONE 'Asia/Kolkata')::date = $3::date
       LIMIT 1`,
    [tenantId, funnelId, dateKey],
  );
  return rows.length > 0;
}

/**
 * Drive file ids this funnel has already posted or scheduled (the stitch step's video): how
 * the ready-video lanes hide posted files when they can't rename them in Drive.
 */
export async function postedDriveIds(funnelId, tenantId = 'default') {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT DISTINCT s->'artifacts'->'video'->>'driveId' AS drive_id
       FROM instances, jsonb_array_elements(steps) s
      WHERE tenant_id = $1 AND funnel_id = $2 AND status IN ('posted', 'scheduled', 'partial', 'failed')
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
      WHERE i.tenant_id = $1 AND i.funnel_id = $2 AND i.status IN ('draft', 'transcript_review', 'video_review') AND i.locked = false
        AND s->>'key' = 'stitch' AND s->'artifacts'->'video'->>'driveId' = ANY($3)
      ORDER BY s->'artifacts'->'video'->>'driveId', i.updated_at DESC`,
    [tenantId, funnelId, driveIds],
  );
  return Object.fromEntries(rows.map((r) => [r.drive_id, r]));
}

/**
 * The LIVE instance (not failed / superseded) delivering this funnel's post on
 * this IST date (yyyy-MM-dd), or null: the router's "already lined up" check.
 * Same date rule as existsForFunnelOnDate; a posted one counts.
 */
export async function liveOnDate(funnelId, dateKey, tenantId = 'default') {
  if (!funnelId || !dateKey) return null;
  const { rows } = await query(
    `SELECT * FROM instances
       WHERE tenant_id = $1 AND funnel_id = $2
         AND status NOT IN ('failed', 'superseded')
         -- A festival post goes out on top of the day's normal post, never instead of it.
         AND COALESCE(source_type, '') <> 'festival'
         AND COALESCE(scheduled_for, posted_at) IS NOT NULL
         AND (COALESCE(scheduled_for, posted_at) AT TIME ZONE 'Asia/Kolkata')::date = $3::date
       ORDER BY (status IN ('scheduled', 'posted', 'partial')) DESC, created_at
       LIMIT 1`,
    [tenantId, funnelId, dateKey],
  );
  return rows[0] || null;
}

/** Sheet-row keys (source_ref) held by this funnel's open image-lane instances. */
export async function openSheetRefs(funnelId, tenantId = 'default') {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT DISTINCT source_ref FROM instances
      WHERE tenant_id = $1 AND funnel_id = $2 AND source_type = 'sheet'
        AND source_ref IS NOT NULL AND status NOT IN ('posted', 'failed', 'superseded')`,
    [tenantId, funnelId],
  );
  return rows.map((r) => r.source_ref);
}

/**
 * Drive file ids of this funnel's ready videos the router has already lined up
 * for a day (a draft or a copy awaiting approval, with a slot): Lane 1 skips them.
 */
export async function routerHeldDriveIds(funnelId, tenantId = 'default') {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT DISTINCT source_ref FROM instances
      WHERE tenant_id = $1 AND funnel_id = $2 AND source_type IN ('drive_folder', 'drive_pick')
        AND source_ref IS NOT NULL AND scheduled_for IS NOT NULL
        AND status IN ('draft', 'transcript_review', 'video_review')`,
    [tenantId, funnelId],
  );
  return rows.map((r) => r.source_ref);
}

/** Router re-run: unlink a not-yet-approved ready-video draft from its day (it stays a draft). */
export async function releaseSlot(id) {
  const { rowCount } = await query(
    `UPDATE instances SET scheduled_for = NULL, status = 'draft', updated_at = now()
      WHERE id = $1 AND locked = false AND status IN ('draft', 'transcript_review', 'video_review')`,
    [id],
  );
  return rowCount > 0;
}

/** Router re-run: replace a not-yet-approved instance (frees its sheet row; old links do nothing). */
export async function supersede(id, note = 'replaced by a router re-run') {
  const { rowCount } = await query(
    `UPDATE instances SET status = 'superseded', note = $2, updated_at = now()
      WHERE id = $1 AND locked = false AND status NOT IN ('approved', 'scheduled', 'posted', 'partial')`,
    [id, note],
  );
  return rowCount > 0;
}

/** This funnel's most recent instances (any lane), for the router's post history. */
export async function recentForFunnel(funnelId, tenantId = 'default', limit = 40) {
  if (!funnelId) return [];
  const { rows } = await query(
    `SELECT id, title, status, source_type, steps, created_at FROM instances
      WHERE tenant_id = $1 AND funnel_id = $2 AND status NOT IN ('superseded')
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, funnelId, limit],
  );
  return rows;
}

/** Festival posts (one instance per funnel, grouped by source_ref = the batch id), newest first. */
export async function festivalRows(tenantId = 'default', limit = 200) {
  const { rows } = await query(
    `SELECT id, funnel_id, funnel_name, title, status, note, steps, source_ref, scheduled_for, posted_at, post_refs, created_at
       FROM instances
      WHERE tenant_id = $1 AND source_type = 'festival'
      ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export default {
  festivalRows,
  create, get, list, logRows, saveSteps, setStatus, transition, setMeta, setSource, bumpRound, lockAsPosted, markScheduled, markPartial, moveFunnel, unschedule, scheduledDue, retryDue, setPostStatus, markPosting, markPostFailed, remove,
  existsForFunnelOnDate, videoOnDate, postedDriveIds, draftsByDriveIds, liveOnDate, openSheetRefs, recentForFunnel,
  routerHeldDriveIds, releaseSlot, supersede, missingLinks, saveLinks, logAttempt,
};
