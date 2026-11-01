/**
 * Daily post router.
 *
 * Purpose:      Posting positive: every active funnel posts something every
 *               day. Each afternoon (the tenant's router_check_time, default
 *               16:00 IST; GitHub wake.yml or the internal cron) the router decides
 *               which lane delivers TOMORROW's post per funnel and records the
 *               decision in router_days (docs/daily-router-plan.md).
 * Responsibility:
 *               - runCheck: one run at a time, inside the heartbeat, over every
 *                 tenant's active funnels (or only tenantIds, when given). Idempotent: a funnel + post date that
 *                 already has a router_days row is skipped.
 *               - decideFunnel: a live instance already lined up for that date
 *                 → record its lane ('already scheduled'). Otherwise Lane 1
 *                 (the oldest ready video) → Lane 2 (a researched AI video,
 *                 when there is credit) → Lane 3 (the image post). Each lane's
 *                 reason for passing is kept on router_days.reason. A day
 *                 nothing could be lined up for is recorded as 'none' with
 *                 the reason, and the operator gets one email.
 *               - rerun: the super-admin "Re-run tomorrow's check", drop the
 *                 funnel's day, replace (or unlink) what was not approved yet,
 *                 decide again.
 * Dependencies: funnelsRepository, instanceRepository, routerDaysRepository,
 *               readyLaneService, aiLaneService, imageLaneService,
 *               providerFactory, core/heartbeat, utils/{routerSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as routerDays from '../repositories/routerDaysRepository.js';
import * as imageLane from './imageLaneService.js';
import * as readyLane from './readyLaneService.js';
import * as aiLane from './aiLaneService.js';
import * as readyPost from './readyPostService.js';
import * as credit from './creditService.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { buildProviders } from './providerFactory.js';
import * as heartbeat from '../core/heartbeat.js';
import { routerTarget, runsOn, laneForInstance, existingReason, rerunAction, pickOldestVideo, nudgeNeeded, NUDGE_TEXT } from '../utils/routerSpec.js';
import { nowIst, formatIst, todayKeyIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const baseLog = childLogger({ module: 'router' });

/** Tell the operator a funnel has no post lined up for that day (best-effort). */
async function sendNoPostEmail({ funnel, f, scheduledFor, reason, log }) {
  try {
    const providers = await buildProviders(funnel.tenant_id);
    const to = f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
    if (!to) return;
    const day = formatIst(scheduledFor, { withTime: false });
    await providers.mail.send({
      to,
      subject: `🟡 No ${funnel.name} post lined up for ${day}`,
      html: `<p>The daily router could not line up ${funnel.name}'s post for ${formatIst(scheduledFor)} IST.</p>
        <p><b>Why:</b> ${String(reason).replace(/[&<>]/g, '')}</p>
        <p>Fix it, then run the router check again (POST /api/v1/jobs/router-check?retry=1).</p>`,
    });
  } catch (err) {
    log.warn({ err: err.message, funnel: funnel.name }, 'no-post email failed');
  }
}

/**
 * Decide one funnel's lane for tomorrow. Returns
 * { funnel, postDate, lane, reason, instanceId, skipped }.
 */
export async function decideFunnel({ funnel, now = nowIst(), retryNone = false, log = baseLog }) {
  const f = await funnels.resolve(funnel);
  const { scheduledFor, postDate } = routerTarget(f.publishTime, now);
  const out = { funnel: funnel.name, funnelId: funnel.id, postDate };
  if (retryNone) await routerDays.releaseNone(funnel.id, postDate);
  const decided = await routerDays.get(funnel.id, postDate);
  if (decided) return { ...out, lane: decided.lane, reason: decided.reason, instanceId: decided.instance_id, skipped: true };

  const base = { tenantId: funnel.tenant_id, funnelId: funnel.id, postDate };
  const record = async (lane, reason, instanceId = null) => {
    const row = await routerDays.claim({ ...base, lane, reason, instanceId });
    return row ? { ...out, lane, reason, instanceId } : { ...out, skipped: true, reason: 'decided by a parallel run' };
  };

  if (!runsOn(f.generateDays, now)) return record('none', 'not a run day for this funnel (Days to run)');

  // Something already delivers that day (a scheduled ready video, an AI video
  // in review, a posted item): record its lane and leave it alone.
  const existing = await instanceRepo.liveOnDate(funnel.id, postDate, funnel.tenant_id);
  if (existing) return record(laneForInstance(existing), existingReason(existing), existing.id);

  // Claim the day first so a parallel run can't double it, then try each lane.
  const day = await routerDays.claim({ ...base, lane: 'ready_video', reason: 'preparing' });
  if (!day) return { ...out, skipped: true, reason: 'decided by a parallel run' };
  const flog = log.child({ funnel: funnel.name });
  const passed = [];
  const note = (lane, err) => {
    passed.push(`${lane}: ${err.message}`);
    flog.info({ lane, err: err.message }, 'router: lane passed');
  };
  const done = async (lane, reason, instanceId) => {
    const why = passed.length ? `${reason} (${passed.join('; ')})` : reason;
    await routerDays.update(day.id, { lane, reason: why, instanceId });
    return { ...out, lane, reason: why, instanceId };
  };

  // Lane 1: the oldest ready video.
  try {
    const r = await readyLane.prepare({ funnelRow: funnel, scheduledFor, log: flog });
    return done('ready_video', r.approval ? 'ready video: approval email sent' : 'ready video: scheduled (own thumbnail + caption)', r.instance && r.instance.id);
  } catch (err) {
    note('ready video', err);
  }
  // Lane 2: a researched AI video (two approvals).
  try {
    const inst = await aiLane.prepare({ funnelRow: funnel, scheduledFor, postDate, log: flog });
    return done('ai_video', 'AI video: script sent for approval', inst.id);
  } catch (err) {
    note('AI video', err);
  }
  // Lane 3: the image post (fail-safe).
  try {
    const inst = await imageLane.prepare({ funnelRow: funnel, scheduledFor, log: flog });
    return done('image', 'image lane: approval email sent', inst.id);
  } catch (err) {
    const reason = `image lane failed: ${err.message}`;
    log.warn({ funnel: funnel.name, postDate, err: err.message }, 'router: no post lined up');
    const res = await done('none', reason, null);
    await sendNoPostEmail({ funnel, f, scheduledFor, reason: res.reason, log });
    return res;
  }
}

async function runOnce({ now = nowIst(), retryNone = false, funnelId = null, tenantIds = null, log = baseLog } = {}) {
  const active = await funnels.listActive();
  const results = [];
  for (const funnel of active) {
    if (funnelId && Number(funnelId) !== Number(funnel.id)) continue;
    if (tenantIds && !tenantIds.includes(funnel.tenant_id)) continue;
    try {
      results.push(await decideFunnel({ funnel, now, retryNone, log }));
    } catch (err) {
      log.error({ err: err.message, funnel: funnel.name }, 'router: funnel failed');
      results.push({ funnel: funnel.name, funnelId: funnel.id, lane: 'error', reason: err.message });
    }
  }
  log.info({ checked: results.length, decided: results.filter((r) => !r.skipped).length }, 'router check done');
  return results;
}

/**
 * The router check (POST /jobs/router-check). One run at a time: a second
 * ping while one runs gets the same promise. Held awake by the heartbeat.
 */
let running = null;
export function runCheck(opts = {}) {
  if (running) return running;
  running = heartbeat.during('router', () => runOnce(opts)).finally(() => { running = null; });
  return running;
}

/**
 * Super-admin re-run of one funnel's check for tomorrow: drop its router_days
 * row, replace (or, for a ready video, unlink) the instance it held if it was
 * not approved yet, then decide again. Runs in the background under the
 * heartbeat; returns what was released straight away.
 */
export async function rerun({ funnelId, tenantId = null, now = nowIst(), log = baseLog }) {
  const funnel = await funnels.get(Number(funnelId));
  if (!funnel || (tenantId && String(funnel.tenant_id) !== String(tenantId))) throw new Error('funnel not found');
  const f = await funnels.resolve(funnel);
  const { postDate } = routerTarget(f.publishTime, now);
  const old = await routerDays.release(funnel.id, postDate);
  // What the day held, or (no row) whatever is lined up for that date.
  const row = old && old.instance_id
    ? await instanceRepo.get(old.instance_id)
    : await instanceRepo.liveOnDate(funnel.id, postDate, funnel.tenant_id);
  const action = rerunAction(row);
  if (action === 'supersede') await instanceRepo.supersede(row.id);
  if (action === 'release') await instanceRepo.releaseSlot(row.id);
  log.info({ funnel: funnel.name, postDate, action, instance: row && row.id }, 'router re-run');
  heartbeat.during('router', () => decideFunnel({ funnel, now, log }))
    .then((r) => log.info({ funnel: funnel.name, lane: r.lane, reason: r.reason }, 'router re-run decided'))
    .catch((err) => log.error({ err: err.message, funnel: funnel.name }, 'router re-run failed'));
  return { funnel: funnel.name, postDate, released: !!old, action, instanceId: row ? row.id : null };
}

/**
 * The 10:00 nudge (POST /jobs/nudge): per tenant, when some active funnel has
 * neither a ready video waiting nor AI-video credit for tomorrow, ONE email a
 * day with the one-line nudge. Returns [{ tenantId, sent, empty: [funnel] }].
 */
export async function runNudge({ tenantIds = null, log = baseLog } = {}) {
  const active = await funnels.listActive();
  const byTenant = new Map();
  for (const funnel of active) {
    if (tenantIds && !tenantIds.includes(funnel.tenant_id)) continue;
    let readyVideo = false;
    let aiVideo = false;
    try {
      const { files, posted } = await readyPost.folderFiles({ funnelId: funnel.id });
      const held = await instanceRepo.routerHeldDriveIds(funnel.id, funnel.tenant_id).catch(() => []);
      readyVideo = !!pickOldestVideo(files, [...posted, ...held]);
    } catch (err) {
      log.warn({ funnel: funnel.name, err: err.message }, 'nudge: ready folder unreadable');
    }
    try {
      const cfg = await funnels.getConfig(funnel.id).catch(() => ({}));
      aiVideo = (await credit.check({ tenantId: funnel.tenant_id, funnelCfg: cfg })).ok;
    } catch (err) {
      log.warn({ funnel: funnel.name, err: err.message }, 'nudge: credit check failed');
    }
    if (!byTenant.has(funnel.tenant_id)) byTenant.set(funnel.tenant_id, []);
    byTenant.get(funnel.tenant_id).push({ name: funnel.name, readyVideo, aiVideo });
  }
  const out = [];
  const today = todayKeyIst();
  for (const [tenantId, list] of byTenant) {
    const empty = list.filter((x) => !x.readyVideo && !x.aiVideo).map((x) => x.name);
    let sent = false;
    // One a day: the wake job may ping twice inside its window.
    if (nudgeNeeded(list) && (await tenantConfig.get(tenantId, 'nudge_sent_on').catch(() => null)) !== today) {
      try {
        const providers = await buildProviders(tenantId);
        const to = providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
        if (to) {
          await providers.mail.send({ to, subject: `🟡 Video lanes are empty (${empty.join(', ')})`, html: `<p>${NUDGE_TEXT}</p>` });
          await tenantConfig.set(tenantId, 'nudge_sent_on', today);
          sent = true;
        }
      } catch (err) {
        log.warn({ tenantId, err: err.message }, 'nudge email failed');
      }
    }
    out.push({ tenantId, sent, empty });
  }
  log.info({ tenants: out.length, sent: out.filter((x) => x.sent).length }, 'nudge check done');
  return out;
}

/** A tenant's router decisions between two IST dates (yyyy-MM-dd, inclusive). */
export function listDays({ tenantId = 'default', from, to }) {
  return routerDays.listByDates(tenantId, from, to);
}

export default { runCheck, decideFunnel, rerun, runNudge, listDays };
