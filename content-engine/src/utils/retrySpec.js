/**
 * Library Retry button (pure).
 *
 * Purpose:      Every failed instance gets one ↻ Retry. What it does depends on
 *               how far the instance got, so a retry never redoes finished work.
 * Responsibility: retryAction(row, steps) names the action. No I/O.
 * Dependencies: utils/laneSpec.
 *
 * Actions: channels (re-post to the ❌ channels), script (write the script
 * again), stages (carry on from the failed stage), final (the reel exists but
 * posting failed: back to the final review), image (the sheet row again, back
 * to approval), open (the instance's own page has the way forward: post again,
 * or a manual run's per-stage button), '' (no retry).
 *
 * Stuck counts as failed: a restart or a lost GitHub run leaves an instance
 * 'running' with nobody working on it, so it is offered once it has said nothing
 * for RETRY_STUCK_MS.
 */
import { laneOf } from './laneSpec.js';

const RENDER_STAGES = ['images', 'animate', 'voiceover', 'transcript', 'stitch'];

export const RETRY_STUCK_MS = 45 * 60 * 1000;

/** True when a 'running' instance has been silent long enough to be lost. */
export function isStuck(row, now = Date.now()) {
  const r = row || {};
  return r.status === 'running' && !!r.updated_at && now - new Date(r.updated_at).getTime() > RETRY_STUCK_MS;
}

export function retryAction(row, steps, now = Date.now()) {
  const r = row || {};
  const list = Array.isArray(steps) ? steps : [];
  const step = (key) => list.find((s) => s.key === key) || {};
  if (r.locked) return '';
  if (['partial', 'failed'].includes(r.status) && (step('publish').artifacts?.channels || []).some((c) => c.state === 'failed')) return 'channels';
  if (r.post_status === 'post_failed') return 'open';
  if (r.status === 'manual' && list.some((s) => s.status === 'failed')) return 'open';
  if (r.status !== 'failed' && !isStuck(r, now)) return '';
  const lane = laneOf(r);
  if (lane === 'image') return 'image';
  // 'generated' is what the router and the scheduler save their AI videos as.
  if (lane !== 'pipeline' && lane !== 'generated') return 'open';
  if (step('script').status === 'failed' || !step('script').artifacts?.text) return 'script';
  if (RENDER_STAGES.some((k) => step(k).status === 'failed')) return 'stages';
  return step('stitch').artifacts?.video?.driveId ? 'final' : 'stages';
}

export default { RETRY_STUCK_MS, isStuck, retryAction };
