/**
 * Run log repository.
 *
 * Purpose:      Trace every instance: each pass (first run, every Retry or
 *               Remake), how each ended (success or failed, with the error),
 *               and every delete. One row per event in run_log, kept after the
 *               instance itself is gone.
 * Responsibility: Writes never throw (the log must never stop a run); reads
 *               for the Run log page.
 * Dependencies: core/db (core/logger loaded only when a write fails).
 */
import { query } from '../core/db.js';

const PASS_EVENTS = ['retry', 'remake'];
const clean = (v, n = 1000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * One event. Title, funnel and tenant come from the instance row (or `row`
 * when the instance is being deleted). The pass is 1 + the retries and
 * remakes already logged, counting this one when it starts a pass.
 */
export async function write(instanceId, event, { detail = '', by = '', row = null } = {}) {
  if (!instanceId || !event) return;
  try {
    const starts = PASS_EVENTS.includes(event);
    await query(
      `INSERT INTO run_log (tenant_id, instance_id, title, funnel_name, pass, event, detail, by_email)
       SELECT COALESCE($5, i.tenant_id, 'default'), $1::uuid, COALESCE($6, i.title, ''), COALESCE($7, i.funnel_name, ''),
              1 + (SELECT count(*)::int FROM run_log r WHERE r.instance_id = $1::uuid AND r.event = ANY($8::text[])) + $9,
              $2, $3, $4
         FROM (SELECT 1) one LEFT JOIN instances i ON i.id = $1::uuid`,
      [instanceId, event, clean(detail), clean(by, 200), row ? row.tenant_id || null : null, row ? row.title ?? null : null,
        row ? row.funnel_name ?? null : null, PASS_EVENTS, starts ? 1 : 0],
    );
  } catch (err) {
    const { childLogger } = await import('../core/logger.js').catch(() => ({}));
    childLogger?.({ module: 'runLog' }).warn({ err: err.message, instance: instanceId, event }, 'run log not written');
  }
}

/** Statuses that end a pass well: it reached a review, a schedule or a post. */
const SUCCESS = {
  script_review: 'script ready for your review',
  transcript_review: 'transcript ready for your review',
  final_review: 'video ready for your review',
  image_review: 'image post ready for your review',
  video_review: 'ready video waiting for your approval',
  review: 'ready for your review',
  scheduled: 'scheduled on Post for Me',
  posted: 'posted',
  draft: 'ready video prepared',
};

/** The event for a status change, or null when it ends nothing (running, approved...). */
export function outcomeFor(status, note = '') {
  if (status === 'failed') return { event: 'failed', detail: note || 'no reason given' };
  if (status === 'disapproved_hold') return { event: 'disapproved', detail: note || 'disapproved' };
  if (status === 'partial') return { event: 'failed', detail: `partly posted: ${note || 'some channels failed'}` };
  if (SUCCESS[status]) return { event: 'success', detail: SUCCESS[status] };
  return null;
}

/** Log the outcome of a status change (no-op for statuses that end nothing). */
export async function statusChanged(instanceId, status, note) {
  const o = outcomeFor(status, note);
  if (o) await write(instanceId, o.event, { detail: o.detail });
}

/** Newest first, optionally one instance (by full id or its first characters). */
export async function list({ tenantId = 'default', instance = '', limit = 500 } = {}) {
  const prefix = clean(instance, 36).toLowerCase().replace(/[^0-9a-f-]/g, '');
  const { rows } = await query(
    `SELECT instance_id::text AS instance_id, title, funnel_name, pass, event, detail, by_email, at
       FROM run_log
      WHERE tenant_id = $1 AND ($2 = '' OR instance_id::text LIKE $2 || '%')
      ORDER BY at DESC, id DESC LIMIT $3`,
    [tenantId, prefix, Math.min(2000, Math.max(1, Number(limit) || 500))],
  );
  return rows;
}

export default { write, outcomeFor, statusChanged, list };
