/**
 * Disapprove and Remake: a post you don't want, gone with its record kept, or
 * made again with your corrections.
 *
 * Purpose:      ✕ Disapprove (with your reason) closes the run's approval so an
 *               older email link can't approve it, and holds the run for
 *               HOLD_SECONDS: its Disapprove button turns off and 🔁 Remake
 *               turns on. Nothing more happens in that window.
 *               - 🔁 Remake (your corrections): the attempt you turned down goes
 *                 to the log (Log and cost) as Disapproved with its own id, its
 *                 run's id, its number and its real cost (the run's cost goes back
 *                 to 0 for the next attempt), and the run is made
 *                 again by its own lane's rework with your corrections, then
 *                 waits for approval again (Approve / Disapprove are back).
 *               - No Remake in time: the hold ends the old way: a sheet row it
 *                 came from reads Disapproved, the files the app made are
 *                 deleted from Drive, and the run moves to the log with its cost.
 *               Every reason and correction is kept as a lesson (lessons_image,
 *               lessons_video) and added to every later image or video-script
 *               prompt, so the app learns from them.
 * Dependencies: instanceRepository, approvalRepository, approvalService,
 *               tenantConfigRepository, tenantSettings, imageLaneService,
 *               driveConnectService, utils/{disapproveSpec,lessonSpec,
 *               approvalButtons}, logger.
 */
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as approvals from '../repositories/approvalRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { invalidate as invalidateSettings } from '../core/tenantSettings.js';
import * as instanceService from './instanceService.js';
import * as driveConnect from './driveConnectService.js';
import { canDisapprove, appDriveFiles } from '../utils/disapproveSpec.js';
import { HOLD_STATUS, HOLD_SECONDS, addLesson, lessonsText, holdLeft } from '../utils/lessonSpec.js';
import { waitStatusOf, APPROVAL_WAIT_STATUSES } from '../utils/approvalButtons.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'disapprove' });

/** Keep one lesson (image or video) for the tenant; the next prompt has it. */
export async function learn(tenantId, what, text, from = '') {
  const key = what === 'video' ? 'lessons_video' : 'lessons_image';
  const t = String(text || '').trim();
  if (!t) return false;
  const now = await tenantConfig.get(tenantId, key).catch(() => null);
  await tenantConfig.set(tenantId, key, lessonsText(addLesson(now, t)));
  invalidateSettings(tenantId);
  return true;
}

async function closeApproval(row) {
  // Close it first, so a click on an older email link can't approve it now.
  const open = await approvals.openForInstance(row.id).catch(() => null);
  if (open) {
    await approvals.consumeToken(open.id).catch(() => null);
    await approvals.setStatus(open.id, 'disapproved').catch(() => null);
  }
}

/** The end of a disapproval: sheet row, the app's own Drive files, then the log. */
async function finish(tenantId, row, by = '') {
  if (row.source_type === 'sheet') {
    const lane = await import('./imageLaneService.js');
    await lane.markDisapproved(row).catch((err) => log.warn({ err: err.message, instance: row.id }, 'sheet row not marked Disapproved'));
  }
  const ids = appDriveFiles(row, instanceService.parseSteps(row));
  let files = 0;
  const filesLeft = [];
  if (ids.length) {
    const client = await driveConnect.drive(tenantId).then((d) => d.client).catch(() => null);
    for (const id of ids) {
      try {
        if (!client) throw new Error('Google Drive is not connected');
        await client.deleteFile(id);
        files += 1;
      } catch (err) {
        filesLeft.push(id);
        log.warn({ err: err.message, file: id, instance: row.id }, 'file not deleted');
      }
    }
  }
  await instanceRepo.setStatus(row.id, 'disapproved', `Disapproved${by ? ` by ${by}` : ''}${row.note ? `: ${row.note}` : ''}`.slice(0, 500));
  if (!(await instanceRepo.remove(row.id))) throw new Error('could not move it to the record (is it locked?)');
  log.info({ instance: row.id, funnel: row.funnel_name, files, left: filesLeft.length }, 'disapproved');
  return { ok: true, files, filesLeft: filesLeft.length };
}

/**
 * Disapprove at once, no Remake (a failed run, the festival page, the old route).
 * Returns { ok, files, filesLeft }.
 */
export async function disapprove({ tenantId = 'default', instanceId, by = '', reason = '' }) {
  const row = await instanceRepo.get(instanceId);
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new Error('not found');
  if (!canDisapprove(row) && row.status !== HOLD_STATUS) throw new Error('this one is already approved, out or locked, so it cannot be disapproved');
  await closeApproval(row);
  if (reason) await learn(tenantId, 'image', reason, 'disapprove').catch(() => false);
  return finish(tenantId, { ...row, note: reason || row.note }, by);
}

const timers = new Map();

/** Run a due hold to its end (no Remake came). Safe to call twice: only one wins. */
export async function finalizeHold({ tenantId = 'default', instanceId, by = '' }) {
  timers.delete(String(instanceId));
  const row = await instanceRepo.get(instanceId);
  if (!row || row.status !== HOLD_STATUS) return null;
  if (holdLeft(row) > 0) return null;
  // Claim it: a Remake pressed at this moment loses cleanly instead of racing.
  if (!(await instanceRepo.transition(row.id, HOLD_STATUS, 'disapproved_final'))) return null;
  return finish(tenantId, { ...row, status: 'disapproved_final' }, by).catch((err) => {
    log.error({ err: err.message, instance: row.id }, 'disapprove hold could not finish');
    return null;
  });
}

/** Every hold that has run out, for one tenant (the Library load and the 5-minute check). */
export async function finalizeDue(tenantId = 'default', rows = null) {
  const list = rows || (await instanceRepo.list({ tenantId, status: HOLD_STATUS }).catch(() => []));
  let n = 0;
  for (const r of list || []) {
    if (r.status === HOLD_STATUS && holdLeft(r) === 0 && await finalizeHold({ tenantId, instanceId: r.id })) n += 1;
  }
  return n;
}

/**
 * ✕ Disapprove with your reason: the approval closes and the run waits
 * HOLD_SECONDS for 🔁 Remake. Returns { ok, holdSeconds }.
 */
export async function hold({ tenantId = 'default', instanceId, reason = '', by = '' }) {
  const row = await instanceRepo.get(instanceId);
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new Error('not found');
  if (!APPROVAL_WAIT_STATUSES.includes(row.status)) throw new Error('only a run waiting for your approval can be disapproved and remade');
  const why = String(reason || '').trim();
  if (!why) throw new Error('give a reason, so the app can learn from it');
  await closeApproval(row);
  if (!(await instanceRepo.transition(row.id, row.status, HOLD_STATUS, `Disapproved: ${why}`.slice(0, 500)))) throw new Error('it changed meanwhile, reload the page');
  await learn(tenantId, 'image', why, 'disapprove').catch((err) => log.warn({ err: err.message }, 'lesson not saved'));
  const id = String(row.id);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { finalizeHold({ tenantId, instanceId: id, by }).catch(() => null); }, (HOLD_SECONDS + 2) * 1000));
  log.info({ instance: row.id, reason: why }, 'disapproved, held for remake');
  return { ok: true, holdSeconds: HOLD_SECONDS };
}

/** You are writing corrections: the minute starts again. Returns true while it is still held. */
export async function extendHold({ tenantId = 'default', instanceId }) {
  const row = await instanceRepo.get(instanceId);
  if (!row || String(row.tenant_id) !== String(tenantId) || row.status !== HOLD_STATUS) return false;
  if (!(await instanceRepo.transition(row.id, HOLD_STATUS, HOLD_STATUS))) return false;
  const id = String(row.id);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { finalizeHold({ tenantId, instanceId: id }).catch(() => null); }, (HOLD_SECONDS + 2) * 1000));
  return true;
}

/**
 * 🔁 Remake with your corrections (what: 'image' for the picture and copy,
 * 'video' for the video): the old attempt goes to the log, the run is made
 * again by its lane. Returns { ok }.
 */
export async function remake({ tenantId = 'default', instanceId, corrections = '', what = 'image' }) {
  const row = await instanceRepo.get(instanceId);
  if (!row || String(row.tenant_id) !== String(tenantId)) throw new Error('not found');
  if (row.status !== HOLD_STATUS) throw new Error('press ✕ Disapprove first; Remake works for one minute after it');
  const fix = String(corrections || '').trim();
  if (!fix) throw new Error('write what to correct, so the remake and the app both use it');
  const approval = await approvals.latestForInstance(row.id);
  const back = waitStatusOf(approval);
  if (!approval || !back) throw new Error('this run has no approval to remake from');
  // Claim the run back from the hold first, so the timer cannot finish it.
  if (!(await instanceRepo.transition(row.id, HOLD_STATUS, back, `Remake: ${fix}`.slice(0, 500)))) throw new Error('the minute ran out: it is already in the log');
  clearTimeout(timers.get(String(row.id)));
  timers.delete(String(row.id));

  // The turned-down attempt, with what it really cost, moves to the log; the run starts its next attempt at 0.
  const reason = String(row.note || '').replace(/^Disapproved:\s*/, '');
  const logged = await instanceRepo.logAttempt(row, {
    title: [row.title || 'Untitled', reason ? 'disapproved: ' + reason : '', 'remake: ' + fix].filter(Boolean).join(' · ').slice(0, 500),
  }).catch((err) => { log.warn({ err: err.message, instance: row.id }, 'old attempt not logged'); return null; });
  await learn(tenantId, what === 'video' ? 'video' : 'image', fix, 'remake').catch((err) => log.warn({ err: err.message }, 'lesson not saved'));

  const note = what === 'video' ? `Video corrections: ${fix}` : fix;
  if (!(await import('./approvalService.js')).reworkById(approval, note)) {
    await instanceRepo.setStatus(row.id, 'failed', 'Remake: this kind of run has no remake');
    throw new Error('this kind of run cannot be remade');
  }
  log.info({ instance: row.id, kind: approval.kind, what, corrections: fix, attempt: logged && logged.attempt, cost: logged && logged.cost }, 'remake started');
  return { ok: true, attempt: logged ? logged.attempt : null, cost: logged ? logged.cost : null };
}

export default { disapprove, hold, remake, extendHold, finalizeHold, finalizeDue, learn };
