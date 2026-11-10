/**
 * Cloudflare waker (pure).
 *
 * Purpose:      One Cloudflare Worker on the owner's account wakes the app once
 *               a day per tenant, at that tenant's Daily time (IST). The Worker
 *               checks every 5 minutes inside Cloudflare (that never wakes the
 *               app) and pings POST /api/v1/jobs/daily?tenant=<id> only for a
 *               tenant whose time has come and who has not run yet today. A
 *               failed ping is tried again at the next check, so a missed day
 *               heals itself within minutes.
 * Responsibility:
 *               - WORKER_SOURCE: the Worker's code (an ES module).
 *               - workerName: one Worker per deployment (staging and prod never
 *                 share one), named from the app's public address.
 *               - dailyTimeOf / tenantTimesMap: what the Worker reads from KV.
 *               - cfRequests: the Cloudflare API calls the deploy makes.
 * Dependencies: none.
 */

export const WAKE_CRON = '*/5 * * * *';
export const DAILY_KEY = 'daily_time';
export const DAILY_DEFAULT = '19:00';
export const RAN_DAILY_KEY = 'wake_ran_daily';
export const LAST_DAILY_KEY = 'wake_daily_last';
export const DEPLOY_KEY = 'cloudflare_wake_deployed';
export const KV_TENANTS = 'tenants';
const API = 'https://api.cloudflare.com/client/v4';

export const WORKER_SOURCE = `// Written by content-engine (Settings > Tenants > Wake-up timer). Do not edit here:
// press Deploy waker in the app instead, or your change is overwritten.
const IST_MS = 330 * 60000;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch() {
    return new Response('automation waker', { status: 200 });
  },
};

async function run(env) {
  const now = new Date(Date.now() + IST_MS).toISOString();
  const day = now.slice(0, 10);
  const hhmm = now.slice(11, 16);
  let tenants = {};
  try { tenants = JSON.parse((await env.WAKE.get('${KV_TENANTS}')) || '{}'); } catch (e) { tenants = {}; }
  for (const [id, time] of Object.entries(tenants)) {
    if (!/^\\d\\d:\\d\\d$/.test(String(time)) || hhmm < time) continue;
    const ranKey = 'ran:' + id + ':' + day;
    if (await env.WAKE.get(ranKey)) continue;
    const ok = await ping(env, id);
    if (ok) await env.WAKE.put(ranKey, new Date().toISOString(), { expirationTtl: 3 * 86400 });
    await env.WAKE.put('last:' + id, JSON.stringify({ at: new Date().toISOString(), ok, day }));
  }
}

// The app may be asleep: its first answer can take a while, so try 3 times.
async function ping(env, id) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetch(env.APP_URL + '/api/v1/jobs/daily?tenant=' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'X-Admin-Key': env.ADMIN_KEY },
        signal: AbortSignal.timeout(60000),
      });
      if (r.ok) return true;
    } catch (e) { /* still starting: try again */ }
    await new Promise((res) => setTimeout(res, 20000));
  }
  return false;
}
`;

/** 'automation-wake-<first label of the app host>', within Cloudflare's 63 characters. */
export function workerName(baseUrl = '') {
  let host = '';
  try { host = new URL(String(baseUrl)).hostname; } catch { host = ''; }
  const label = (host.split('.')[0] || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `automation-wake-${label || 'app'}`.slice(0, 63).replace(/-$/, '');
}

/** One tenant's daily time, HH:MM 24-hour; blank or unreadable is the default. */
export function dailyTimeOf(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return DAILY_DEFAULT;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** { tenantId: 'HH:MM' } for every active tenant, as the Worker reads it. */
export function tenantTimesMap(rows = []) {
  const out = {};
  for (const r of rows) {
    if (!r || !r.tenantId) continue;
    if (r.status && r.status !== 'active') continue;
    out[String(r.tenantId)] = dailyTimeOf(r.time);
  }
  return out;
}

/** The IST day a daily run belongs to: the date of its time. */
export function istDay(now) {
  return now.toFormat('yyyy-MM-dd');
}

/** The Cloudflare API calls (url + init) the deploy and sync make. */
export const cfRequests = {
  listKv: (account, token) => ({ url: `${API}/accounts/${account}/storage/kv/namespaces?per_page=100`, init: { headers: auth(token) } }),
  createKv: (account, token, title) => ({
    url: `${API}/accounts/${account}/storage/kv/namespaces`,
    init: { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) },
  }),
  putScript: (account, token, name, { kvId, appUrl, adminKey }) => {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      main_module: 'worker.js',
      compatibility_date: '2025-06-01',
      bindings: [
        { type: 'kv_namespace', name: 'WAKE', namespace_id: kvId },
        { type: 'plain_text', name: 'APP_URL', text: appUrl },
        { type: 'secret_text', name: 'ADMIN_KEY', text: adminKey },
      ],
    })], { type: 'application/json' }));
    form.append('worker.js', new Blob([WORKER_SOURCE], { type: 'application/javascript+module' }), 'worker.js');
    return { url: `${API}/accounts/${account}/workers/scripts/${name}`, init: { method: 'PUT', headers: auth(token), body: form } };
  },
  putSchedules: (account, token, name) => ({
    url: `${API}/accounts/${account}/workers/scripts/${name}/schedules`,
    init: { method: 'PUT', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify([{ cron: WAKE_CRON }]) },
  }),
  putValue: (account, token, kvId, key, value) => {
    const form = new FormData();
    form.append('value', String(value));
    form.append('metadata', '{}');
    return { url: `${API}/accounts/${account}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`, init: { method: 'PUT', headers: auth(token), body: form } };
  },
  getValue: (account, token, kvId, key) => ({
    url: `${API}/accounts/${account}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`, init: { headers: auth(token) },
  }),
};

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/** A Cloudflare API answer's first error, in plain words. */
export function cfError(json, status) {
  const e = ((json && json.errors) || [])[0];
  if (e) return `Cloudflare ${status}: ${e.message || e.code}`;
  return `Cloudflare answered ${status}`;
}

export default { WAKE_CRON, DAILY_KEY, DAILY_DEFAULT, RAN_DAILY_KEY, LAST_DAILY_KEY, DEPLOY_KEY, KV_TENANTS, WORKER_SOURCE, workerName, dailyTimeOf, tenantTimesMap, istDay, cfRequests, cfError };
