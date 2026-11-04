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
 * to approval), open (the instance's own page posts it again), '' (no retry).
 */
import { laneOf } from './laneSpec.js';

const RENDER_STAGES = ['images', 'animate', 'voiceover', 'transcript', 'stitch'];

export function retryAction(row, steps) {
  const r = row || {};
  const list = Array.isArray(steps) ? steps : [];
  const step = (key) => list.find((s) => s.key === key) || {};
  if (r.locked) return '';
  if (['partial', 'failed'].includes(r.status) && (step('publish').artifacts?.channels || []).some((c) => c.state === 'failed')) return 'channels';
  if (r.post_status === 'post_failed') return 'open';
  if (r.status !== 'failed') return '';
  const lane = laneOf(r);
  if (lane === 'image') return 'image';
  if (lane !== 'pipeline') return 'open';
  if (step('script').status === 'failed' || !step('script').artifacts?.text) return 'script';
  if (RENDER_STAGES.some((k) => step(k).status === 'failed')) return 'stages';
  return step('stitch').artifacts?.video?.driveId ? 'final' : 'stages';
}

export default { retryAction };
