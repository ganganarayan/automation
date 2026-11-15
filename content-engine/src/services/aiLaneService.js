/**
 * Daily router: Lane 2: the researched, narrated AI video.
 *
 * Purpose:      When no ready video is waiting, make one: check credit, research
 *               a new topic from the funnel's landing page + post history, write
 *               the script and open approval 1. The existing pipeline then
 *               takes over (docs/daily-router-plan.md, Lane 2):
 *               approve → images → animate (no lip sync, the provider picked
 *               here) → ElevenLabs narrator → ffmpeg on GitHub Actions →
 *               approval 2 → Post for Me at scheduled_for, or now if late.
 * Responsibility:
 *               - prepare: credit gate (once-per-dry-spell email when out),
 *                 research, instance, script, script review. Throws LaneSkip
 *                 when Lane 2 can't run today (the router falls through).
 *               - onStageFailed: a router AI video failed mid-render → mark an
 *                 out-of-credit provider for the day, then the image post for
 *                 that day instead: animation failed = the same instance, from
 *                 its own still (imageLane.stepDown); otherwise, or if that
 *                 can't be done, the next sheet row. The Log says which and why.
 * Dependencies: creditService, stageRunnerService, instanceReviewService,
 *               imageLaneService, funnelsRepository, instanceRepository,
 *               instanceService, routerDaysRepository, providerFactory,
 *               utils/{routerSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as routerDays from '../repositories/routerDaysRepository.js';
import * as instanceService from './instanceService.js';
import * as credit from './creditService.js';
import * as stageRunner from './stageRunnerService.js';
import * as review from './instanceReviewService.js';
import * as imageLane from './imageLaneService.js';
import * as stepLog from './stepLogService.js';
import * as heartbeat from '../core/heartbeat.js';
import { buildProviders } from './providerFactory.js';
import { meter } from './usageMeter.js';
import { costText } from '../utils/pricing.js';
import { researchPrompt, normalizeResearch, historyLines, instanceHistoryLine, isCreditError, rerunAction } from '../utils/routerSpec.js';
import { retitleForDate } from '../utils/retrySpec.js';
import { stepDownNote } from '../utils/stepDownSpec.js';
import { formatIst, ZONE } from '../utils/time.js';
import { DateTime } from 'luxon';
import { childLogger } from '../core/logger.js';

const baseLog = childLogger({ module: 'aiLane' });

// Videos whose sheet step-down is being made right now (it takes a minute or
// two): a second failure meanwhile must not take another row.
const steppingDown = new Set();

/** Lane 2 can't run today (out of credit / not set up): the router moves on. */
export class LaneSkip extends Error {}

/**
 * Line up tomorrow's AI video for one funnel. Returns the instance (at
 * script_review, approval 1 open); throws LaneSkip or Error.
 */
export async function prepare({ funnelRow, scheduledFor, postDate, prompt = '', model = '', log = baseLog }) {
  const f = await funnels.resolve(funnelRow);
  if (!(f.accounts || []).length) throw new LaneSkip('no Post for Me accounts ticked on this funnel');
  const saved = await funnels.getConfig(f.id).catch(() => ({}));
  // A model picked by the caller (MCP create_video) is tried first, then the funnel's own order.
  const cfg = model ? { ...saved, video_provider_order: [model, saved.video_provider_order].filter(Boolean).join(',') } : saved;
  const verdict = await credit.check({ tenantId: f.tenantId, funnelCfg: cfg });
  await credit.noteVerdict(f.tenantId, verdict);
  if (!verdict.ok) throw new LaneSkip(`AI video lane out: ${verdict.missing.join(', ')}`);

  const providers = await buildProviders(f.tenantId);
  const researchFrom = new Date().toISOString();
  // A typed topic (MCP create_video) skips the research step.
  const brief = prompt ? normalizeResearch({ topic: prompt, title: prompt.slice(0, 120) }) : await research({ f, providers, log });
  const researchTo = new Date().toISOString();

  const inst = await instanceService.createForFunnel({
    tenantId: f.tenantId,
    funnel: funnelRow,
    title: `${brief.title || brief.topic} · ${formatIst(scheduledFor, { withTime: false })}`,
    scheduledFor: scheduledFor.toJSDate(),
    status: 'running',
    sourceType: 'generated',
  });
  await stepLog.span(inst.id, 'research', researchFrom, researchTo);
  await instanceService.updateStep(inst.id, 'script', { artifacts: { brief, router: { lane: 'ai_video', provider: verdict.provider, postDate } } });
  try {
    await stageRunner.generateScript({ instanceId: inst.id });
    await review.requestReview({ tenantId: f.tenantId, instanceId: inst.id, checkpoint: 'script' });
  } catch (err) {
    await instanceRepo.setStatus(inst.id, 'failed', `AI video lane: ${err.message}`).catch(() => {});
    if (isCreditError(err.message)) await credit.markExhausted(f.tenantId, 'llm').catch(() => {});
    throw err;
  }
  log.info({ funnel: f.name, instance: inst.id, provider: verdict.provider, topic: brief.topic }, 'AI video lined up (script sent for approval)');
  return inst;
}

/** The research step: a new topic from the landing page and the post history. */
async function research({ f, providers, log }) {
  const [page, recent] = await Promise.all([
    imageLane.landingText(f.landingPageUrl, log),
    instanceRepo.recentForFunnel(f.id, f.tenantId, 40).catch(() => []),
  ]);
  const { system, user } = researchPrompt({
    funnelName: f.name, landingUrl: f.landingPageUrl, landingText: page, history: historyLines(recent.map(instanceHistoryLine), 40),
  });
  const researched = await providers.llm.generateJsonDetailed({ system, user, maxTokens: 2000 });
  meter(providers, costText({ ...(researched.usage || {}), model: researched.model }), 'lane 2 research');
  return normalizeResearch(researched.data);
}

// Which credit an out-of-credit error at a step uses up.
const CREDIT_KEY = { script: 'llm', images: 'image', voiceover: 'voice' };

/**
 * A router AI video failed mid-render: drop that funnel to the image lane for
 * its day and tell the operator why. Other instances are ignored.
 */
export async function onStageFailed(instanceId, stepKey, err) {
  const row = await instanceRepo.get(instanceId);
  if (!row || !row.funnel_id) return;
  const { router } = stageRunner.routerInfo(row);
  if (!router || router.lane !== 'ai_video') return;
  const log = baseLog.child({ instance: instanceId });
  const reason = `${stepKey || 'render'}: ${err.message}`;

  if (isCreditError(err.message)) {
    const key = stepKey === 'animate' ? router.provider : CREDIT_KEY[stepKey];
    await credit.markExhausted(row.tenant_id, key).catch(() => {});
  }

  const funnelRow = await funnels.get(row.funnel_id);
  if (!funnelRow) return;
  const scheduledFor = DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(ZONE);
  const postDate = router.postDate || scheduledFor.toFormat('yyyy-MM-dd');
  const day = await routerDays.get(row.funnel_id, postDate);
  // A re-run (or a later decision) already replaced this video: nothing to do.
  if (!day || (day.instance_id && String(day.instance_id) !== String(instanceId))) return;

  // A video steps down once. A retry that fails again (or a second failure while
  // the first step-down is still being made) never takes another sheet row.
  if (router.stepDownTo || steppingDown.has(String(instanceId))) {
    const held = router.stepDownTo ? await instanceRepo.get(router.stepDownTo).catch(() => null) : null;
    if (held && !['failed', 'superseded'].includes(held.status)) {
      await routerDays.update(day.id, { lane: 'image', reason: `AI video retry failed (${reason}); its earlier image post keeps the day`, instanceId: held.id });
    }
    await stepLog.mark(instanceId, 'step_down', `Failed again, no new sheet row taken${held ? ': the image post made the first time keeps the day' : ''}. Why: ${reason}`.slice(0, 300));
    log.warn({ reason, stepDownTo: router.stepDownTo || null }, 'AI video failed again; already stepped down once, no new sheet row');
    return;
  }

  // Animation failed: the still is already made and paid for, so that goes first.
  // Everything else, and a still that can't be used, takes the next sheet row.
  let still = '';
  if (stepKey === 'animate') {
    try {
      if (await imageLane.stepDown({ instanceId, reason: `animation failed: ${err.message}`, log })) {
        await routerDays.update(day.id, { lane: 'image', reason: `Animation failed (${err.message}); image post from the video's own still: waiting for approval`, instanceId });
        log.warn({ reason }, 'animation failed; stepped down to an image post from its own still');
      }
      return;
    } catch (e) {
      still = `; its still could not be used: ${e.message}`;
      log.warn({ err: e.message }, 'image step-down from the still failed; trying the content sheet');
    }
  }

  steppingDown.add(String(instanceId));
  try {
    const inst = await imageLane.prepare({ funnelRow, scheduledFor, log });
    // Remembered on the video, so a retry keeps this post instead of taking another row.
    const now = stageRunner.routerInfo(await instanceRepo.get(instanceId)).router || router;
    await instanceService.updateStep(instanceId, 'script', { artifacts: { router: { ...now, stepDownTo: inst.id } } });
    await routerDays.update(day.id, { lane: 'image', reason: `AI video failed (${reason}${still}); image lane: waiting for approval`, instanceId: inst.id });
    await stepLog.mark(instanceId, 'step_down', stepDownNote(`${reason}${still}`, 'sheet'));
  } catch (e) {
    await routerDays.update(day.id, { lane: 'none', reason: `AI video failed (${reason}${still}); image lane failed: ${e.message}` });
  } finally {
    steppingDown.delete(String(instanceId));
  }
  log.warn({ reason }, 'AI video failed mid-render; dropped to the image lane');
}

const dayTaken = (message) => Object.assign(new Error(message), { dayTaken: true });

// The retries that leave the day holding an image post.
const IMAGE_ACTIONS = ['image', 'stepdown'];

/**
 * A retry for a new date: that date must be free, since nothing was approved to be
 * replaced there. Holds the date against the router, moves the row and its router
 * mark, and frees the old date if this row held it.
 */
async function moveToDate(row, action, moved) {
  const { router } = stageRunner.routerInfo(row);
  if (row.funnel_id) {
    const taken = `${moved.text} already has a post for this funnel. Pick another date.`;
    const live = await instanceRepo.liveOnDate(row.funnel_id, moved.postDate, row.tenant_id);
    if (live && String(live.id) !== String(row.id)) throw dayTaken(taken);
    const day = await routerDays.get(row.funnel_id, moved.postDate);
    const fields = { lane: IMAGE_ACTIONS.includes(action) ? 'image' : 'ai_video', reason: 'retried from the Library for this date', instanceId: row.id };
    if (day) {
      const other = day.instance_id && String(day.instance_id) !== String(row.id) ? await instanceRepo.get(day.instance_id) : null;
      if (other && !['failed', 'superseded'].includes(other.status)) throw dayTaken(taken);
      await routerDays.update(day.id, fields);
    } else {
      await routerDays.claim({ tenantId: row.tenant_id, funnelId: row.funnel_id, postDate: moved.postDate, ...fields });
    }
    const was = (router && router.postDate) || (row.scheduled_for ? DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(ZONE).toFormat('yyyy-MM-dd') : '');
    const old = was && was !== moved.postDate ? await routerDays.get(row.funnel_id, was) : null;
    if (old && String(old.instance_id) === String(row.id)) await routerDays.release(row.funnel_id, was);
  }
  await instanceRepo.setMeta(row.id, { scheduledFor: moved.at, title: retitleForDate(row.title, moved.text) || undefined });
  if (router) await instanceService.updateStep(row.id, 'script', { artifacts: { router: { ...router, postDate: moved.postDate } } });
}

/**
 * A retried instance takes its router day back, so a funnel never posts twice:
 * a replacement still waiting is replaced, one already approved stops the retry
 * and asks for a new date.
 */
async function takeDay(row, action) {
  const { router } = stageRunner.routerInfo(row);
  if ((action !== 'image' && !router) || !row.funnel_id || !row.scheduled_for) return;
  const postDate = (router && router.postDate) || DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(ZONE).toFormat('yyyy-MM-dd');
  const day = await routerDays.get(row.funnel_id, postDate);
  if (!day) return;
  if (day.instance_id && String(day.instance_id) !== String(row.id)) {
    // The video's own step-down post keeps the day while the video is retried;
    // it is replaced only when the video is posted (claimFromStepDown).
    if (!IMAGE_ACTIONS.includes(action) && router && router.stepDownTo && String(router.stepDownTo) === String(day.instance_id)) return;
    const other = await instanceRepo.get(day.instance_id);
    const act = rerunAction(other);
    if (act === 'keep' && !['failed', 'superseded'].includes(other.status)) {
      throw dayTaken(`${formatIst(row.scheduled_for, { withTime: false })} already has an approved post for this funnel, so this one needs its own date.`);
    }
    if (act === 'supersede') await instanceRepo.supersede(other.id, 'replaced by a retry');
    if (act === 'release') await instanceRepo.releaseSlot(other.id);
  }
  await routerDays.update(day.id, { lane: IMAGE_ACTIONS.includes(action) ? 'image' : 'ai_video', reason: 'retried from the Library', instanceId: row.id });
}

/**
 * ↻ Retry a failed instance on the same id (action from utils/retrySpec):
 * script, stages (keeps what is done), final (back to the final review), image
 * or stepdown. Claims it now, runs in the background; a failure reads Failed again.
 * moved (utils/retrySpec parseRetryDate) runs it for a new date instead of its own.
 */
export async function retry({ instanceId, action, moved = null }) {
  const row = await instanceRepo.get(instanceId);
  if (!row) throw new Error('instance not found');
  // From failed, or from running when it was found stuck (this also restarts its quiet clock).
  if (!(await instanceRepo.transition(row.id, row.status, 'running'))) throw new Error('this has moved on (already retrying?)');
  try {
    await (moved ? moveToDate(row, action, moved) : takeDay(row, action));
  } catch (err) {
    await instanceRepo.setStatus(row.id, row.status);
    throw err;
  }
  const log = baseLog.child({ instance: row.id });
  log.info({ action }, 'retry started');
  const run = {
    script: () => stageRunner.runScriptAndReview({ instanceId: row.id }),
    stages: () => stageRunner.runStages({ instanceId: row.id, resume: true }),
    final: () => review.requestReview({ tenantId: row.tenant_id, instanceId: row.id, checkpoint: 'final' }),
    image: () => imageLane.retry({ instanceId: row.id, log }),
    stepdown: () => imageLane.retryStepDown({ instanceId: row.id, log }),
  }[action];
  heartbeat.during('retry', run).catch(async (err) => {
    log.error({ err: err.message, action }, 'retry failed');
    await instanceRepo.setStatus(row.id, 'failed', `Retry: ${err.message}`).catch(() => {});
  });
  return { instanceId: row.id, action };
}

/**
 * Before a retried router video is posted: its step-down image post gives the
 * day back (superseded), so the funnel never posts twice. An image post already
 * approved or scheduled stops the video with a plain reason instead.
 */
export async function claimFromStepDown(instanceId) {
  const row = await instanceRepo.get(instanceId);
  if (!row || !row.funnel_id) return;
  const { router } = stageRunner.routerInfo(row);
  if (!router || !router.stepDownTo) return;
  const held = await instanceRepo.get(router.stepDownTo).catch(() => null);
  if (!held || ['failed', 'superseded'].includes(held.status)) return;
  const when = row.scheduled_for ? formatIst(row.scheduled_for, { withTime: false }) : 'that day';
  if (rerunAction(held) === 'keep') {
    throw new Error(`${when} already has this video's image post (${held.title || held.id}) approved, so the video would post twice. Retry the video for a new date, or take the image post down first.`);
  }
  await instanceRepo.supersede(held.id, 'replaced by its retried AI video');
  const postDate = router.postDate || DateTime.fromJSDate(new Date(row.scheduled_for)).setZone(ZONE).toFormat('yyyy-MM-dd');
  const day = await routerDays.get(row.funnel_id, postDate);
  if (day && (!day.instance_id || String(day.instance_id) === String(held.id))) {
    await routerDays.update(day.id, { lane: 'ai_video', reason: 'the retried AI video replaced its image post', instanceId: row.id });
  }
  await stepLog.mark(row.id, 'step_down', `Posted as the video; its image post ${String(held.id).slice(0, 8)} was withdrawn.`);
}

export default { LaneSkip, prepare, onStageFailed, retry, claimFromStepDown };
