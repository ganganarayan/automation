/**
 * Wake schedule service.
 *
 * Purpose:      Keep GitHub's wake-up times in step with the Daily schedule
 *               (IST) settings. The app sleeps; .github/workflows/wake.yml runs
 *               every 15 minutes, reads the repository variable WAKE_SCHEDULE
 *               and pings the job endpoints whose times are due.
 * Responsibility:
 *               - schedule: the union of every tenant's times.
 *               - dueTenants: tenants whose time for a job is due now and whose
 *                 slot has not run yet (router-check and nudge run only those
 *                 on a plain wake ping); marks the slot as run.
 *               - sync: write WAKE_SCHEDULE with the default tenant's GitHub
 *                 token + repo (the ones set for Video clean), and store the
 *                 outcome under wake_schedule_synced on the default tenant.
 *               - status: the last sync, for the Settings page.
 * Dependencies: tenantRepository, tenantConfigRepository, core/tenantSettings,
 *               utils/{wakeSchedule,cleanHookSpec,time}, logger.
 */
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import {
  WAKE_KEYS, SYNC_KEY, SERVER_WINDOW_MIN, buildWakeSchedule, tenantTimes, dueSlot, ranKey, variableRequests, syncOutcome,
} from '../utils/wakeSchedule.js';
import { DEFAULT_REPO } from '../utils/cleanHookSpec.js';
import { nowIst, formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'wake-schedule' });

const RAN_KEYS = ['router', 'nudge'].map(ranKey);

/** Every tenant's config map (the wake keys and last-run slots), with its id. */
async function tenantConfigs() {
  const list = await tenantRepo.list().catch(() => [{ id: 'default' }]);
  const out = [];
  for (const t of list.length ? list : [{ id: 'default' }]) {
    const all = await tenantConfig.getAll(t.id).catch(() => ({}));
    out.push({ tenantId: t.id, cfg: Object.fromEntries([...WAKE_KEYS, ...RAN_KEYS].map((k) => [k, all[k]])) });
  }
  return out;
}

/** The wake schedule across all tenants. */
export async function schedule() {
  return buildWakeSchedule((await tenantConfigs()).map((x) => x.cfg));
}

/**
 * Tenant ids whose time for `job` (router = router_check_time, nudge =
 * nudge_time) fell within the catch-up window (IST, plus cold-start slack)
 * and whose slot has not run yet. Each returned tenant's slot is marked as
 * run (wake_ran_<job>), so a later ping in the same window skips it.
 */
export async function dueTenants({ now = nowIst(), job = 'router' } = {}) {
  const out = [];
  for (const { tenantId, cfg } of await tenantConfigs()) {
    const slot = dueSlot(tenantTimes(cfg)[job], now, SERVER_WINDOW_MIN);
    if (!slot || cfg[ranKey(job)] === slot.key) continue;
    await tenantConfig.set(tenantId, ranKey(job), slot.key);
    log.info({ tenantId, job, slot: slot.key }, 'wake: slot due, running');
    out.push(tenantId);
  }
  return out;
}

/** True when a saved form changed any wake key (old map vs. new map). */
export function changed(before = {}, after = {}) {
  return WAKE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''));
}

async function readReason(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text).message || text.slice(0, 200); } catch { return text.slice(0, 200); }
}

/**
 * Write WAKE_SCHEDULE (PATCH; on 404 create it). Never throws: the outcome
 * { ok, message, at, schedule } is stored and returned.
 */
export async function sync() {
  const at = new Date().toISOString();
  let result;
  let sched = null;
  try {
    sched = await schedule();
    const c = (await tenantSettings.forTenant('default')).clean || {};
    const { patch, post } = variableRequests({ repo: c.githubRepo || DEFAULT_REPO, token: c.githubToken, value: JSON.stringify(sched) });
    let res = await fetch(patch.url, patch.init);
    if (res.status === 404) res = await fetch(post.url, post.init);
    result = { ...syncOutcome(res.status, res.ok ? '' : await readReason(res)), status: res.status };
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  const stored = { ...result, at, schedule: sched };
  await tenantConfig.set('default', SYNC_KEY, JSON.stringify(stored)).catch((err) => log.warn({ err: err.message }, 'could not store the sync result'));
  if (result.ok) log.info({ schedule: sched }, 'wake schedule synced to GitHub');
  else log.warn({ reason: result.message }, 'wake schedule sync failed');
  return view(stored);
}

/** The stored outcome as the page shows it: 🟢 synced at DD-MM-YYYY HH:MM, or 🟡 the reason. */
function view(stored) {
  if (!stored || !stored.at) return { ok: false, never: true, text: '🟡 Not synced yet. Press Sync wake-up times once.' };
  const when = formatIst(stored.at);
  const text = stored.ok ? `🟢 synced at ${when} IST` : `🟡 ${stored.message} (tried ${when} IST)`;
  return { ok: !!stored.ok, at: stored.at, text, schedule: stored.schedule || null };
}

/** The last sync and the schedule it should hold now. */
export async function status() {
  let stored = null;
  try { stored = JSON.parse((await tenantConfig.get('default', SYNC_KEY)) || 'null'); } catch { stored = null; }
  const current = await schedule();
  const v = view(stored);
  const stale = !!(v.schedule && JSON.stringify(v.schedule) !== JSON.stringify(current));
  return { ...v, current, stale };
}

export default { schedule, dueTenants, changed, sync, status };
