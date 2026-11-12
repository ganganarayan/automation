/**
 * Cloudflare waker service.
 *
 * Purpose:      Deploy and keep in step the one Cloudflare Worker that wakes the
 *               app once a day per tenant (utils/cloudflareWake has the Worker
 *               and the API calls). Only the owner's Cloudflare account is
 *               used; tenants just pick their Daily time in Settings.
 * Responsibility:
 *               - saveCredentials: the owner's account id + API token, kept on
 *                 the default tenant (the token is never shown again).
 *               - deploy: KV namespace (made once), the Worker with its
 *                 bindings, the 5-minute check, then the tenants' times.
 *               - syncTimes: write { tenantId: 'HH:MM' } to KV. Called when a
 *                 Daily time is saved and by every daily run, so a new tenant
 *                 is picked up without anyone pressing a button.
 *               - status: the deploy outcome and each tenant's last daily run.
 * Dependencies: tenantRepository, tenantConfigRepository, settings,
 *               utils/{cloudflareWake,time}, logger.
 */
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { settings } from '../settings/index.js';
import {
  DAILY_KEY, DEPLOY_KEY, LAST_DAILY_KEY, KV_TENANTS, workerName, dailyTimeOf, tenantTimesMap, cfRequests, cfError,
} from '../utils/cloudflareWake.js';
import { formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'cloudflare-wake' });
const ACCOUNT_KEY = 'cloudflare_account_id';
const TOKEN_KEY = 'cloudflare_api_token';
const KV_ID_KEY = 'cloudflare_wake_kv_id';

async function creds() {
  const [account, token, kvId] = await Promise.all([ACCOUNT_KEY, TOKEN_KEY, KV_ID_KEY].map((k) => tenantConfig.get('default', k).catch(() => '')));
  return { account: String(account || '').trim(), token: String(token || '').trim(), kvId: String(kvId || '').trim() };
}

async function call({ url, init }) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) throw new Error(cfError(json, res.status));
  return json;
}

/**
 * The waker's name: the one already deployed keeps its name even when this
 * server's address changes (Railway reports a custom domain once one is added).
 */
async function wakerName() {
  try {
    const d = JSON.parse((await tenantConfig.get('default', DEPLOY_KEY)) || 'null');
    if (d && d.ok && /^automation-wake-[a-z0-9-]+$/.test(String(d.worker || ''))) return d.worker;
  } catch { /* fall through */ }
  return workerName(settings.app.publicBaseUrl);
}

/** Save the owner's Cloudflare account id and token (a blank token keeps the saved one). */
export async function saveCredentials({ account = '', token = '' }) {
  const a = String(account || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(a)) throw new Error('the account ID is 32 letters and digits (Cloudflare dashboard, right side of the account home)');
  await tenantConfig.set('default', ACCOUNT_KEY, a);
  if (String(token || '').trim()) await tenantConfig.set('default', TOKEN_KEY, String(token).trim());
  return status();
}

/** Every active tenant's Daily time. */
async function tenantTimes() {
  const list = await tenantRepo.list().catch(() => [{ id: 'default', status: 'active' }]);
  const rows = [];
  for (const t of list) rows.push({ tenantId: t.id, status: t.status, time: await tenantConfig.get(t.id, DAILY_KEY).catch(() => '') });
  return tenantTimesMap(rows);
}

/** Write the tenants' times to the Worker's KV. Quietly does nothing before the first deploy. */
export async function syncTimes() {
  const { account, token, kvId } = await creds();
  if (!account || !token || !kvId) return { ok: false, skipped: true };
  const times = await tenantTimes();
  await call(cfRequests.putValue(account, token, kvId, KV_TENANTS, JSON.stringify(times)));
  log.info({ tenants: Object.keys(times).length }, 'daily times synced to Cloudflare');
  return { ok: true, times };
}

/**
 * Create or update everything on Cloudflare. Never throws: the outcome is kept
 * under cloudflare_wake_deployed and returned with status().
 */
export async function deploy() {
  const at = new Date().toISOString();
  const name = await wakerName();
  let outcome;
  try {
    const { account, token } = await creds();
    if (!account || !token) throw new Error('save the Cloudflare account ID and API token first');
    if (!settings.app.publicBaseUrl) throw new Error('this server has no public address (PUBLIC_BASE_URL)');
    if (!settings.auth.adminKey) throw new Error('this server has no admin key (ADMIN_KEY)');
    // The KV namespace: found by its name, made the first time.
    const list = await call(cfRequests.listKv(account, token));
    let kv = ((list && list.result) || []).find((n) => n.title === name);
    if (!kv) kv = (await call(cfRequests.createKv(account, token, name))).result;
    await tenantConfig.set('default', KV_ID_KEY, kv.id);
    await call(cfRequests.putScript(account, token, name, { kvId: kv.id, appUrl: settings.app.publicBaseUrl.replace(/\/+$/, ''), adminKey: settings.auth.adminKey }));
    await call(cfRequests.putSchedules(account, token, name));
    const synced = await syncTimes();
    outcome = { ok: true, at, worker: name, tenants: Object.keys(synced.times || {}).length };
    log.info(outcome, 'Cloudflare waker deployed');
  } catch (err) {
    outcome = { ok: false, at, worker: name, message: err.message };
    log.warn(outcome, 'Cloudflare waker deploy failed');
  }
  await tenantConfig.set('default', DEPLOY_KEY, JSON.stringify(outcome)).catch(() => {});
  return status();
}

/** For the Tenants page: the deploy outcome and each tenant's time and last daily run. */
export async function status() {
  const { account, token } = await creds();
  let deployed = null;
  try { deployed = JSON.parse((await tenantConfig.get('default', DEPLOY_KEY)) || 'null'); } catch { deployed = null; }
  const text = !deployed
    ? '🟡 Not deployed yet. Save the account ID and token, then press Deploy waker.'
    : deployed.ok
      ? `🟢 ${deployed.worker} deployed ${formatIst(deployed.at)} IST, checks every 5 minutes`
      : `🔴 ${deployed.message} (tried ${formatIst(deployed.at)} IST)`;
  const list = await tenantRepo.list().catch(() => []);
  const tenants = [];
  for (const t of list) {
    const [time, last] = await Promise.all([tenantConfig.get(t.id, DAILY_KEY).catch(() => ''), tenantConfig.get(t.id, LAST_DAILY_KEY).catch(() => '')]);
    let l = null;
    try { l = JSON.parse(last || 'null'); } catch { l = null; }
    tenants.push({
      id: t.id, name: t.name, status: t.status, time: dailyTimeOf(time),
      last: l ? `${l.ok ? '🟢' : '🔴'} ${formatIst(l.at)} IST${l.error ? `: ${l.error}` : ''}` : '🟡 never',
    });
  }
  return { ok: !!(deployed && deployed.ok), text, account, hasToken: !!token, worker: (deployed && deployed.ok && deployed.worker) || workerName(settings.app.publicBaseUrl), tenants };
}

export default { saveCredentials, syncTimes, deploy, status };
