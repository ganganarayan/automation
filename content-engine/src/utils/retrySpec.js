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
import { DateTime } from 'luxon';
import { laneOf } from './laneSpec.js';

const ZONE = 'Asia/Kolkata';

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
  // A script review with no script (sent by hand while it was stuck) has nothing to approve.
  const noScript = r.status === 'script_review' && !step('script').artifacts?.text;
  if (r.status !== 'failed' && !isStuck(r, now) && !noScript) return '';
  const lane = laneOf(r);
  if (lane === 'image') return 'image';
  // 'generated' is what the router and the scheduler save their AI videos as.
  if (lane !== 'pipeline' && lane !== 'generated') return 'open';
  if (step('script').status === 'failed' || !step('script').artifacts?.text) return 'script';
  if (RENDER_STAGES.some((k) => step(k).status === 'failed')) return 'stages';
  return step('stitch').artifacts?.video?.driveId ? 'final' : 'stages';
}

/**
 * A date picked for a retry (a datetime-local value, read as IST). Null unless it
 * is a real time still to come.
 */
export function parseRetryDate(value, now = new Date()) {
  const dt = DateTime.fromFormat(String(value || '').trim(), "yyyy-MM-dd'T'HH:mm", { zone: ZONE });
  if (!dt.isValid || dt.toMillis() <= new Date(now).getTime()) return null;
  return { at: dt.toJSDate(), postDate: dt.toFormat('yyyy-MM-dd'), text: dt.toFormat('dd-MM-yyyy') };
}

/** What the date picker starts on: tomorrow at the row's own time of day, IST. */
export function retryDateDefaults(row, now = new Date()) {
  const today = DateTime.fromJSDate(new Date(now)).setZone(ZONE);
  const was = row && row.scheduled_for ? DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(ZONE) : null;
  const at = today.plus({ days: 1 }).set({ hour: was ? was.hour : 8, minute: was ? was.minute : 0 });
  const value = (d) => d.toFormat("yyyy-MM-dd'T'HH:mm");
  return { min: value(today), suggest: value(at) };
}

/** A title's trailing " · DD-MM-YYYY" follows the new date; any other title stays. */
export function retitleForDate(title, dateText) {
  return String(title || '').replace(/ · \d{2}-\d{2}-\d{4}$/, ` · ${dateText}`);
}

/**
 * The Library's date picker, shown when a retry can't keep its date. The date is
 * also spelled out on the button, because the browser's own picker follows its locale.
 */
export const RETRY_PICK_SCRIPT = `
function retryPick(b, id, j){
  let box=b.parentNode.querySelector('.rtpick');
  if(!box){
    box=document.createElement('div'); box.className='rtpick';
    box.innerHTML='<div class="hint rtmsg"></div><label class="fl">New date and time (IST)<input type="datetime-local"></label><button class="act big rtgo"></button>';
    b.parentNode.appendChild(box);
    const inp=box.querySelector('input'), go=box.querySelector('.rtgo');
    inp.min=j.min||''; inp.value=j.suggest||'';
    const label=()=>{ const m=inp.value.match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}:\\d{2})$/); go.textContent=m?'↻ Retry for '+m[3]+'-'+m[2]+'-'+m[1]+' '+m[4]+' IST':'Pick a date'; go.disabled=!m; };
    inp.addEventListener('input',label); label();
    go.onclick=()=>retryRow(go,id,inp.value);
    b.style.display='none';
  }
  box.querySelector('.rtmsg').textContent='🟡 '+(j.error||'Pick a new date');
}
`;

export default { RETRY_STUCK_MS, isStuck, retryAction, parseRetryDate, retryDateDefaults, retitleForDate, RETRY_PICK_SCRIPT };
