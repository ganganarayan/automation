/**
 * Daily post router.
 *
 * Purpose:      Posting positive: every active funnel posts something every
 *               day. Each afternoon (16:00 IST, GitHub cron) the router decides
 *               which lane delivers TOMORROW's post per funnel and records the
 *               decision in router_days (docs/daily-router-plan.md).
 * Responsibility:
 *               - runCheck: one run at a time, inside the heartbeat, over every
 *                 tenant's active funnels. Idempotent: a funnel + post date that
 *                 already has a router_days row is skipped.
 *               - decideFunnel: a live instance already lined up for that date
 *                 → record its lane ('already scheduled'). Otherwise (Lane 1 and
 *                 Lane 2 automation are later build steps) → Lane 3, the image
 *                 post. A day nothing could be lined up for is recorded as
 *                 'none' with the reason, and the operator gets one email.
 * Dependencies: funnelsRepository, instanceRepository, routerDaysRepository,
 *               imageLaneService, providerFactory, core/heartbeat,
 *               utils/{routerSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as routerDays from '../repositories/routerDaysRepository.js';
import * as imageLane from './imageLaneService.js';
import { buildProviders } from './providerFactory.js';
import * as heartbeat from '../core/heartbeat.js';
import { routerTarget, runsOn, laneForInstance, existingReason } from '../utils/routerSpec.js';
import { nowIst, formatIst } from '../utils/time.js';
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

  // Lane 1 (ready video) and Lane 2 (AI video) automation: later build steps.
  // Lane 3: the image post. Claim the day first so a parallel run can't double it.
  const day = await routerDays.claim({ ...base, lane: 'image', reason: 'image lane: preparing' });
  if (!day) return { ...out, skipped: true, reason: 'decided by a parallel run' };
  try {
    const inst = await imageLane.prepare({ funnelRow: funnel, scheduledFor, log: log.child({ funnel: funnel.name }) });
    const reason = 'image lane: approval email sent';
    await routerDays.update(day.id, { reason, instanceId: inst.id });
    return { ...out, lane: 'image', reason, instanceId: inst.id };
  } catch (err) {
    const reason = `image lane failed: ${err.message}`;
    log.warn({ funnel: funnel.name, postDate, err: err.message }, 'router: no post lined up');
    await routerDays.update(day.id, { lane: 'none', reason });
    await sendNoPostEmail({ funnel, f, scheduledFor, reason, log });
    return { ...out, lane: 'none', reason };
  }
}

async function runOnce({ now = nowIst(), retryNone = false, funnelId = null, log = baseLog } = {}) {
  const active = await funnels.listActive();
  const results = [];
  for (const funnel of active) {
    if (funnelId && Number(funnelId) !== Number(funnel.id)) continue;
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

/** A tenant's router decisions between two IST dates (yyyy-MM-dd, inclusive). */
export function listDays({ tenantId = 'default', from, to }) {
  return routerDays.listByDates(tenantId, from, to);
}

export default { runCheck, decideFunnel, listDays };
