/**
 * AI video assembly on GitHub Actions (Lane 2 of the daily router).
 *
 * Purpose:      Run the final ffmpeg stitch (animated clips + narrator voice-
 *               over + burned captions) on a GitHub runner instead of Railway,
 *               the same way ✂ Clean does: the app starts clean-video.yml with
 *               a signed, expiring ticket of kind 'assemble'; the runner's
 *               script (scripts/gha-clean.mjs) sees the kind, stitches with the
 *               SAME args as the Railway path (utils/stageSpec ffmpegConcatArgs),
 *               uploads the reel into the user's Drive app folder and calls back.
 * Responsibility:
 *               - start: share the inputs, sign the ticket, dispatch the
 *                 workflow, hold the heartbeat until done / fail (capped).
 *               - hookJob / hookToken / hookProgress / hookDone / hookFail:
 *                 the callbacks (routed here by modules/cleanHooks when the
 *                 ticket's kind is 'assemble').
 *               - done → the reel is the instance's stitch artifact → the
 *                 final-review email. fail → the stage runner's failure path
 *                 (the router drops that funnel to the image lane).
 * Dependencies: driveConnectService, instanceService, instanceRepository,
 *               instanceReviewService, publicDriveProvider, core/heartbeat,
 *               utils/{cleanHookSpec,stageSpec}, logger.
 */
import * as driveConnect from './driveConnectService.js';
import * as instanceService from './instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as review from './instanceReviewService.js';
import * as heartbeat from '../core/heartbeat.js';
import { publicDlUrl } from '../providers/publicDriveProvider.js';
import { signTicket, peekTicket, readTicket, dispatchRequest, DEFAULT_REPO } from '../utils/cleanHookSpec.js';
import { buildSrt } from '../utils/stageSpec.js';
import { HookError } from './readyPostService.js';
import { childLogger } from '../core/logger.js';
import { formatIst } from '../utils/time.js';

const log = childLogger({ module: 'assemble' });

export const KIND = 'assemble';
const HOLD_MAX_MS = 60 * 60 * 1000;
const holds = new Map();

// The stage runner's failure path (set by registerPipeline; no import cycle).
let onFail = async () => {};
export function setFailHandler(fn) {
  if (typeof fn === 'function') onFail = fn;
}

function hold(instanceId) {
  release(instanceId);
  const free = heartbeat.hold('assemble');
  const cap = setTimeout(() => release(instanceId), HOLD_MAX_MS);
  cap.unref?.();
  holds.set(instanceId, () => { clearTimeout(cap); free(); });
}

function release(instanceId) {
  const free = holds.get(instanceId);
  if (free) { holds.delete(instanceId); free(); }
}

/** True when a hook ticket is an assembly one (not a ✂ Clean). */
export function isAssembleTicket(ticket) {
  return (peekTicket(ticket) || {}).k === KIND;
}

/**
 * Send the stitch to GitHub. clips: [{ driveId }], audioDriveId, cues,
 * width/height. Resolves once the run is queued; the done hook continues.
 */
export async function start({ instance, providers, clips, audioDriveId, cues = [], burnCaptions = true, width, height, baseUrl }) {
  const tenantId = instance.tenant_id || 'default';
  const c = providers.resolved.clean || {};
  if (!(await driveConnect.status(tenantId)).connected) throw new Error('Google Drive is not connected (Setup → Settings → Google)');
  if (!/^https:\/\//.test(baseUrl || '')) throw new Error("the app's public https address is not set, so GitHub can't call back");
  // The runner downloads by public link: make sure every input is shared.
  for (const id of [...clips.map((x) => x.driveId), audioDriveId]) await providers.storage.shareAnyone(id).catch(() => {});
  const payload = {
    t: tenantId, k: KIND, f: instance.funnel_id, d: instance.id,
    c: clips.map((x) => x.driveId), a: audioDriveId, w: width, h: height,
  };
  const srt = burnCaptions && Array.isArray(cues) && cues.length ? buildSrt(cues) : '';
  // Captions can be long: keep them on the instance, not in the ticket.
  await instanceService.updateStep(instance.id, 'stitch', { status: 'running', startedAt: new Date().toISOString(), artifacts: { runner: 'github', srt } });
  const ticket = signTicket(payload, await driveConnect.hookSecret(tenantId));
  const ref = c.githubRef || process.env.RAILWAY_GIT_BRANCH || 'main';
  const { url, init } = dispatchRequest({ repo: c.githubRepo || DEFAULT_REPO, token: c.githubToken, ref, hook: baseUrl, ticket });
  const res = await fetch(url, init);
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message || msg; } catch { /* keep the raw text */ }
    throw new Error(`GitHub refused to start the assembly (${res.status}): ${msg || 'no reason given'}`);
  }
  hold(instance.id);
  log.info({ instance: instance.id, clips: clips.length, ref }, 'assembly sent to GitHub Actions');
}

async function ticketOf(ticket) {
  const peek = peekTicket(ticket);
  if (!peek || !peek.t || peek.k !== KIND) throw new HookError('bad ticket');
  const p = readTicket(ticket, await driveConnect.hookSecret(peek.t));
  if (!p || !p.d) throw new HookError('ticket is invalid or expired');
  return p;
}

/** What the runner needs: the inputs' download links, the size, the captions and a Drive token. */
export async function hookJob({ ticket }) {
  const p = await ticketOf(ticket);
  const inst = await instanceRepo.get(p.d);
  if (!inst || String(inst.tenant_id) !== String(p.t)) throw new HookError('instance not found');
  const stitch = (instanceService.parseSteps(inst).find((s) => s.key === 'stitch') || {}).artifacts || {};
  const { token, folderId } = await driveConnect.drive(p.t);
  return {
    kind: KIND,
    clipUrls: (p.c || []).map((id) => publicDlUrl(id)),
    audioUrl: publicDlUrl(p.a),
    srt: stitch.srt || '',
    width: Number(p.w) || 1080,
    height: Number(p.h) || 1920,
    accessToken: token,
    folderId,
    fileName: `AI video ${String(p.d).slice(0, 8)} (${formatIst(new Date(), { withTime: false })}).mp4`,
  };
}

export async function hookToken({ ticket }) {
  const p = await ticketOf(ticket);
  const { token, folderId } = await driveConnect.drive(p.t);
  return { accessToken: token, folderId };
}

export async function hookProgress({ ticket, phase, pct }) {
  const p = await ticketOf(ticket);
  log.info({ instance: p.d, phase, pct }, 'assembly progress');
  return { ok: true };
}

/** The reel is in the app's Drive folder: it becomes the stitch artifact → final review. */
export async function hookDone({ ticket, fileId, durationSec }) {
  const p = await ticketOf(ticket);
  if (!/^[\w-]{10,}$/.test(String(fileId || ''))) throw new HookError('fileId required');
  const { client, folderId } = await driveConnect.drive(p.t);
  const meta = await client.fileMeta(fileId);
  if (folderId && Array.isArray(meta.parents) && !meta.parents.includes(folderId)) throw new HookError('file is not in the app folder');
  await client.makePublic(fileId);
  const dur = Math.round(Number(durationSec) || 0);
  await instanceService.updateStep(p.d, 'stitch', { status: 'done', artifacts: { video: { driveId: String(fileId), durationSec: dur, runner: 'github' } }, finishedAt: new Date().toISOString() });
  if (dur) await instanceRepo.setMeta(p.d, { durationSeconds: dur });
  release(p.d);
  log.info({ instance: p.d, fileId }, 'AI video assembled on GitHub Actions');
  await review.requestReview({ instanceId: p.d, checkpoint: 'final' });
  return { ok: true };
}

export async function hookFail({ ticket, error }) {
  const p = await ticketOf(ticket);
  release(p.d);
  const msg = String(error || 'the GitHub run failed').slice(0, 400);
  log.warn({ instance: p.d, error: msg }, 'GitHub assembly failed');
  await onFail(p.d, 'stitch', new Error(`GitHub assembly: ${msg}`));
  return { ok: true };
}

export default { KIND, setFailHandler, isAssembleTicket, start, hookJob, hookToken, hookProgress, hookDone, hookFail };
