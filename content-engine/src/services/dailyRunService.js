/**
 * The daily run: everything a tenant needs once a day, at its Daily time.
 *
 * Purpose:      The app sleeps. The Cloudflare waker (utils/cloudflareWake)
 *               calls POST /api/v1/jobs/daily?tenant=<id> once a day at that
 *               tenant's time; this runs, in order: tomorrow's posts (the
 *               router, with each ready video's checked clean), the lanes-empty
 *               nudge, the LinkedIn relay, and the post check. The evening
 *               email with every approval button goes when the app falls quiet
 *               afterwards (digestService via the heartbeat), so it carries
 *               whatever the lanes made.
 * Responsibility:
 *               - claim: once per tenant per IST day, however many pings come.
 *               - run: the jobs one tenant at a time, the outcome kept under
 *                 wake_daily_last for the Tenants page.
 * Dependencies: routerService, linkedinRelayService, readyPostService,
 *               cloudflareWakeService, tenantConfigRepository, core/heartbeat,
 *               utils/{cloudflareWake,time}, logger.
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as heartbeat from '../core/heartbeat.js';
import { RAN_DAILY_KEY, LAST_DAILY_KEY, istDay } from '../utils/cloudflareWake.js';
import { nowIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'daily-run' });
let queue = Promise.resolve();

/** True the first time a tenant asks today; marks the day as taken. */
export async function claim(tenantId, now = nowIst()) {
  const day = istDay(now);
  if ((await tenantConfig.get(tenantId, RAN_DAILY_KEY).catch(() => '')) === day) return false;
  await tenantConfig.set(tenantId, RAN_DAILY_KEY, day);
  return true;
}

async function runOne(tenantId) {
  // Imported here: these services pull in most of the app.
  const routerService = await import('./routerService.js');
  const relay = await import('./linkedinRelayService.js');
  const readyPost = await import('./readyPostService.js');
  const cloudflare = await import('./cloudflareWakeService.js');
  const errors = [];
  const step = async (name, fn) => {
    try { await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); log.warn({ tenantId, step: name, err: err.message }, 'daily run step failed'); }
  };
  await step('router', () => routerService.runCheck({ tenantIds: [tenantId], log }));
  await step('nudge', () => routerService.runNudge({ tenantIds: [tenantId], log }));
  await step('relay', () => relay.pollAndRelay({ tenantId }));
  await step('posts', () => readyPost.refreshAllTenants());
  // Keeps Cloudflare's list of tenants and times current, new tenants included.
  if (tenantId === 'default') await step('times', () => cloudflare.syncTimes());
  const last = { at: new Date().toISOString(), ok: !errors.length, ...(errors.length ? { error: errors.join('; ').slice(0, 300) } : {}) };
  await tenantConfig.set(tenantId, LAST_DAILY_KEY, JSON.stringify(last)).catch(() => {});
  log.info({ tenantId, ok: last.ok, errors }, 'daily run done');
}

/** Run one tenant's day in the background, one tenant at a time, holding the app awake. */
export function start(tenantId) {
  queue = queue.then(() => heartbeat.during('daily', () => runOne(tenantId))).catch((err) => log.error({ tenantId, err: err.message }, 'daily run failed'));
  return queue;
}

export default { claim, start };
