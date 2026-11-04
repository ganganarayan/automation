/**
 * Daily router: Lane 2: the researched, narrated AI video.
 *
 * Purpose:      When no ready video is waiting, make one: check credit, research
 *               a new topic from the funnel's landing page + post history, write
 *               the script and send approval email 1. The existing pipeline then
 *               takes over (docs/daily-router-plan.md, Lane 2):
 *               approve → images → animate (no lip sync, the provider picked
 *               here) → ElevenLabs narrator → ffmpeg on GitHub Actions →
 *               approval email 2 → Post for Me at scheduled_for, or now if late.
 * Responsibility:
 *               - prepare: credit gate (once-per-dry-spell email when out),
 *                 research, instance, script, script review. Throws LaneSkip
 *                 when Lane 2 can't run today (the router falls through).
 *               - onStageFailed: a router AI video failed mid-render → mark an
 *                 out-of-credit provider for the day, then line up the image
 *                 post for that day instead and email why.
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
import { researchPrompt, normalizeResearch, historyLines, instanceHistoryLine, isCreditError, rerunAction } from '../utils/routerSpec.js';
import { retitleForDate } from '../utils/retrySpec.js';
import { formatIst, ZONE } from '../utils/time.js';
import { DateTime } from 'luxon';
import { childLogger } from '../core/logger.js';

const baseLog = childLogger({ module: 'aiLane' });

/** Lane 2 can't run today (out of credit / not set up): the router moves on. */
export class LaneSkip extends Error {}

/**
 * Line up tomorrow's AI video for one funnel. Returns the instance (at
 * script_review, approval email 1 sent); throws LaneSkip or Error.
 */
export async function prepare({ funnelRow, scheduledFor, postDate, log = baseLog }) {
  const f = await funnels.resolve(funnelRow);
  if (!(f.accounts || []).length) throw new LaneSkip('no Post for Me accounts ticked on this funnel');
  const cfg = await funnels.getConfig(f.id).catch(() => ({}));
  const verdict = await credit.check({ tenantId: f.tenantId, funnelCfg: cfg });
  await credit.noteVerdict(f.tenantId, verdict);
  if (!verdict.ok) throw new LaneSkip(`AI video lane out: ${verdict.missing.join(', ')}`);

  const providers = await buildProviders(f.tenantId);
  const researchFrom = new Date().toISOString();
  const [page, recent] = await Promise.all([
    imageLane.landingText(f.landingPageUrl, log),
    instanceRepo.recentForFunnel(f.id, f.tenantId, 40).catch(() => []),
  ]);
  const { system, user } = researchPrompt({
    funnelName: f.name, landingUrl: f.landingPageUrl, landingText: page, history: historyLines(recent.map(instanceHistoryLine), 40),
  });
  const brief = normalizeResearch(await providers.llm.generateJson({ system, user, maxTokens: 2000 }));
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

  let outcome;
  try {
    const inst = await imageLane.prepare({ funnelRow, scheduledFor, log });
    outcome = 'An image post is lined up instead; its approval email is on its way.';
    await routerDays.update(day.id, { lane: 'image', reason: `AI video failed (${reason}); image lane: approval email sent`, instanceId: inst.id });
  } catch (e) {
    outcome = `The image lane failed too: ${e.message}`;
    await routerDays.update(day.id, { lane: 'none', reason: `AI video failed (${reason}); image lane failed: ${e.message}` });
  }
  log.warn({ reason }, 'AI video failed mid-render; dropped to the image lane');
  try {
    const providers = await buildProviders(row.tenant_id);
    const f = await funnels.resolve(funnelRow);
    const to = f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
    if (to) {
      const strip = (s) => String(s).replace(/[&<>]/g, '');
      await providers.mail.send({
        to,
        subject: `🟡 ${f.name} AI video failed: image post instead`,
        html: `<p>The AI video for ${strip(f.name)} (${formatIst(scheduledFor)} IST) failed while rendering.</p>
          <p><b>Why:</b> ${strip(reason)}</p><p>${strip(outcome)}</p>`,
      });
    }
  } catch (e) {
    log.warn({ err: e.message }, 'lane-2 failure email failed');
  }
}

const dayTaken = (message) => Object.assign(new Error(message), { dayTaken: true });

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
    const fields = { lane: action === 'image' ? 'image' : 'ai_video', reason: 'retried from the Library for this date', instanceId: row.id };
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
    const other = await instanceRepo.get(day.instance_id);
    const act = rerunAction(other);
    if (act === 'keep' && !['failed', 'superseded'].includes(other.status)) {
      throw dayTaken(`${formatIst(row.scheduled_for, { withTime: false })} already has an approved post for this funnel, so this one needs its own date.`);
    }
    if (act === 'supersede') await instanceRepo.supersede(other.id, 'replaced by a retry');
    if (act === 'release') await instanceRepo.releaseSlot(other.id);
  }
  await routerDays.update(day.id, { lane: action === 'image' ? 'image' : 'ai_video', reason: 'retried from the Library', instanceId: row.id });
}

/**
 * ↻ Retry a failed instance on the same id (action from utils/retrySpec):
 * script, stages (keeps what is done), final (back to the final review) or
 * image. Claims it now, runs in the background; a failure reads Failed again.
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
  }[action];
  heartbeat.during('retry', run).catch(async (err) => {
    log.error({ err: err.message, action }, 'retry failed');
    await instanceRepo.setStatus(row.id, 'failed', `Retry: ${err.message}`).catch(() => {});
  });
  return { instanceId: row.id, action };
}

export default { LaneSkip, prepare, onStageFailed, retry };
