/**
 * Daily router: Lane 1: the ready video (top priority).
 *
 * Purpose:      Post a video you already made: the next unposted video, by file name, in the
 *               funnel's ready-video Drive folder (D3, deduped by Drive file id)
 *               goes out at the funnel's publish time (docs/daily-router-plan.md,
 *               Lane 1).
 * Responsibility:
 *               - prepare: pick the video, ✂ Clean it first when the funnel
 *                 has Clean on (readyPostService.cleanForRouter: a failed
 *                 clean falls back to the original, noted). Same-name .jpg/.png + .txt next to
 *                 it → that thumbnail + caption, scheduled with no approval.
 *                 Otherwise transcribe → AI caption + headline + thumbnail
 *                 (readyPostService, the transcript gate passed by the router)
 *                 → one approval, linked from the daily email. Throws LaneSkip when there's no video.
 *               - approve: schedule through readyPostService.postSelections at
 *                 scheduled_for, or now if that has passed (D2).
 *               - rework: write the copy again and open a new approval.
 * Dependencies: readyPostService, approvalService, instanceRepository,
 *               instanceService, providerFactory, publishProvider,
 *               utils/{routerSpec,thumbSpec,time}, logger.
 *
 * Instance statuses: transcript_review → draft (router-approved transcript)
 * → video_review (approval open) → draft → scheduled → posted.
 */
import * as readyPost from './readyPostService.js';
import * as approvalService from './approvalService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as instanceService from './instanceService.js';
import * as stepLog from './stepLogService.js';
import { setStatus as setApprovalStatus } from '../repositories/approvalRepository.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { publicDlUrl } from '../providers/publicDriveProvider.js';
import { PLATFORM_SIZE } from '../utils/thumbSpec.js';
import { imagePromptOf } from '../utils/aiCopySpec.js';
import { VIDEO_REVIEW, pickNextVideo, sidecarsFor, copyFromCaption, thumbsForAll, istSlot } from '../utils/routerSpec.js';
import { formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

export const KIND = 'ready_video';

const baseLog = childLogger({ module: 'readyLane' });

/** Lane 1 has nothing to post today: the router moves on. */
export class LaneSkip extends Error {}

const art = (steps, k) => ((steps.find((s) => s.key === k) || {}).artifacts) || {};

/** One selection → Post for Me (via the ready-video poster). Returns the instance id. */
async function schedule({ funnelId, video, copy, thumbs, ctaLink = '', scheduledFor }) {
  const slot = istSlot(scheduledFor);
  const out = await readyPost.postSelections({
    funnelId,
    selections: [{ driveId: video.id, name: video.name, copy, thumbs, ctaLink, scheduledAt: slot, now: !slot }],
  });
  const r = (out.results || [])[0] || {};
  if (!r.ok) throw new Error(r.error || 'Post for Me did not take the video');
  return r.instanceId;
}

/** Open (or re-open) the approval for a draft that has its copy; the daily email carries the link. */
async function sendApproval({ inst, funnel, video, log, clean = null, cleanNote = '' }) {
  const steps = instanceService.parseSteps(await instanceRepo.get(inst.id));
  const copy = art(steps, 'script').copy || {};
  const sizes = art(steps, 'images').sizes || [];
  const thumb = (sizes[0] || {}).url || '';
  const videoUrl = (clean && clean.url) || publicDlUrl(video.id);
  await approvalService.createRequest({
    tenantId: funnel.tenant_id,
    kind: KIND,
    payload: {
      instanceId: inst.id, funnelId: funnel.id, driveId: video.id, name: video.name,
      thumbnailUrl: thumb, videoUrl, caption: [copy.title, copy.description].filter(Boolean).join('\n\n'),
    },
  });
  // A failed clean is worth saying: the daily email and the Library show the note.
  await instanceRepo.setStatus(inst.id, VIDEO_REVIEW, clean ? undefined : (cleanNote || undefined));
  await stepLog.start(inst.id, 'review_copy', { email: 'digest' });
  log.info({ instance: inst.id, video: video.name }, 'ready video waiting for approval');
  return null;
}

/**
 * Line up tomorrow's ready video for one funnel at `scheduledFor` (Luxon
 * DateTime). Returns { instance, approval: boolean }; throws LaneSkip / Error.
 */
export async function prepare({ funnelRow, scheduledFor, log = baseLog, skipped = [] }) {
  const { funnel, resolved, providers, folder, files, posted, drive } = await readyPost.folderFiles({ funnelId: funnelRow.id });
  if (!folder) throw new LaneSkip('no ready-video folder on this funnel');
  if (!(resolved.accounts || []).length) throw new LaneSkip('no Post for Me accounts ticked on this funnel');
  const held = await instanceRepo.routerHeldDriveIds(funnel.id, funnel.tenant_id).catch(() => []);
  const silent = await readyPost.silentDriveIds({ funnel, resolved: providers.resolved, files }).catch(() => []);
  const video = pickNextVideo(files, [...posted, ...held, ...silent, ...skipped]);
  if (!video) throw new LaneSkip('no unposted ready video in the folder');
  const at = scheduledFor.toJSDate();
  const side = sidecarsFor(files, video);
  // ✂ Clean (funnel setting): posting then uses the cleaned copy; a failure keeps the original.
  const { clean, note } = await readyPost.cleanForRouter({ funnelId: funnel.id, driveId: video.id, name: video.name });
  if (note) log.info({ video: video.name, cleaned: !!clean, note }, 'ready video clean');

  // Thumbnail + caption made by you: schedule straight away.
  if (side.thumb && side.caption) {
    const text = (await drive.download(side.caption.id)).toString('utf8');
    const copy = copyFromCaption(text);
    if (!copy.description) throw new Error(`${side.caption.name} is empty`);
    const img = await drive.download(side.thumb.id);
    const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
    const url = await publish.uploadMedia(img, /\.png$/i.test(side.thumb.name) ? 'image/png' : 'image/jpeg');
    const instanceId = await schedule({ funnelId: funnel.id, video, copy, thumbs: thumbsForAll(url, Object.keys(PLATFORM_SIZE)), scheduledFor: at });
    log.info({ video: video.name, instance: instanceId }, 'ready video scheduled with its own thumbnail + caption');
    return { instance: await instanceRepo.get(instanceId), approval: false, note };
  }

  // Otherwise: transcribe → AI copy + thumbnail → one approval, linked from the daily email.
  const t = await readyPost.savedTranscript({ funnelId: funnel.id, driveId: video.id })
    || await readyPost.transcribeVideo({ funnelId: funnel.id, driveId: video.id, name: video.name });
  // No speech and not a comparison: it waits on its page (never paid for again), the next video goes today.
  if (!(await readyPost.approveTranscriptAuto({ funnelId: funnel.id, driveId: video.id, name: video.name }))) {
    await instanceRepo.setMeta(t.instanceId, { title: `${video.name} (no speech: add the text or pick its comparison)` });
    log.warn({ video: video.name }, 'ready video has no speech, left for the operator');
    return prepare({ funnelRow, scheduledFor, log, skipped: [...skipped, video.id] });
  }
  await instanceRepo.setMeta(t.instanceId, { scheduledFor: at, title: `${video.name} · ${formatIst(at, { withTime: false })}` });
  try {
    await readyPost.generateCopy({ funnelId: funnel.id, driveId: video.id, name: video.name });
    const inst = await instanceRepo.get(t.instanceId);
    await sendApproval({ inst, funnel, video, log, clean, cleanNote: note });
    return { instance: inst, approval: true, note };
  } catch (err) {
    // Unlink it from the day: the video stays in the folder for another go.
    await instanceRepo.releaseSlot(t.instanceId).catch(() => {});
    throw err;
  }
}

/** Approve → schedule at its time (or now, if late). */
export async function approve(approval) {
  const p = approval.payload || {};
  const log = baseLog.child({ instance: p.instanceId });
  const row = p.instanceId ? await instanceRepo.get(p.instanceId) : null;
  if (!row) return log.warn('approved ready video has no instance; ignored');
  if (!(await instanceRepo.transition(row.id, VIDEO_REVIEW, 'draft'))) {
    return log.info({ status: row.status }, 'ready video is not awaiting approval; ignored');
  }
  await stepLog.end(row.id, 'review_copy', { by: 'approved' });
  await stepLog.start(row.id, 'publish');
  const steps = instanceService.parseSteps(row);
  const script = art(steps, 'script');
  try {
    await schedule({
      funnelId: row.funnel_id, video: { id: p.driveId, name: p.name }, copy: script.copy || {},
      thumbs: art(steps, 'images').thumbs || {}, ctaLink: script.ctaLink || '', scheduledFor: row.scheduled_for,
    });
    await stepLog.end(row.id, 'publish');
    await setApprovalStatus(approval.id, 'published');
    log.info('approved ready video handed to Post for Me');
  } catch (err) {
    await stepLog.fail(row.id, 'publish');
    log.error({ err: err.message }, 'approved ready video could not be scheduled');
    await instanceRepo.setStatus(row.id, 'failed', `Post for Me: ${err.message}`);
  }
  return null;
}

/** What the email's review page shows beside the payload, read live so a waiting approval has it too. */
export async function reviewFacts(approval) {
  const id = (approval.payload || {}).instanceId;
  const row = id ? await instanceRepo.get(id) : null;
  return row ? { imagePrompt: imagePromptOf(instanceService.parseSteps(row)) } : {};
}

/** Rework: write the copy + thumbnail again, following your note, and open a new approval. */
export async function rework(approval, note = '') {
  const p = approval.payload || {};
  const log = baseLog.child({ instance: p.instanceId });
  const row = p.instanceId ? await instanceRepo.get(p.instanceId) : null;
  if (!row || !(await instanceRepo.transition(row.id, VIDEO_REVIEW, 'draft'))) return log.info('ready video rework ignored');
  await stepLog.end(row.id, 'review_copy', { by: 'rework' });
  try {
    await readyPost.generateCopy({ funnelId: row.funnel_id, driveId: p.driveId, name: p.name, note });
    const { funnel, resolved, providers } = await readyPost.folderFiles({ funnelId: row.funnel_id }).catch(() => ({}));
    const clean = p.videoUrl && p.videoUrl !== publicDlUrl(p.driveId) ? { url: p.videoUrl } : null;
    await sendApproval({ inst: await instanceRepo.get(row.id), funnel, video: { id: p.driveId, name: p.name }, log, clean });
  } catch (err) {
    log.error({ err: err.message }, 'ready video rework failed');
    await instanceRepo.setStatus(row.id, 'failed', `Rework: ${err.message}`);
  }
  return null;
}

export default { KIND, LaneSkip, prepare, approve, rework, reviewFacts };
