/**
 * Landing deploy service.
 *
 * Purpose:      Put the public pages on the owner's domain through Cloudflare:
 *               render them, upload the landing Worker, attach the domain.
 * Responsibility:
 *               - deploy({ domain }): render, upload, attach; never throws, the
 *                 outcome is kept under landing_deployed on the default tenant.
 *               - status: the outcome in plain words.
 *               - liveDomain: the domain the app sends its own public pages to
 *                 (cached a minute), blank until a deploy has worked.
 * Uses the Cloudflare account ID and token saved for the waker (Tenants panel).
 * Dependencies: tenantConfigRepository, core/tenantSettings, settings,
 *               utils/{landingSite,cloudflareWake,time}, logger.
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { settings } from '../settings/index.js';
import {
  LANDING_DEPLOY_KEY, LANDING_DOMAIN_KEY, renderLanding, cleanDomain, zoneCandidates, landingWorkerName, landingRequests,
} from '../utils/landingSite.js';
import { cfError } from '../utils/cloudflareWake.js';
import { formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'landing-deploy' });

async function call({ url, init }) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) throw new Error(cfError(json, res.status));
  return json;
}

async function contactEmail() {
  const e = (await tenantSettings.forTenant('default').catch(() => null))?.emails || {};
  return e.public || e.notify || '';
}

/** Render, upload and attach. Never throws. */
export async function deploy({ domain = '' } = {}) {
  const at = new Date().toISOString();
  const name = landingWorkerName(settings.app.publicBaseUrl);
  const host = cleanDomain(domain || (await tenantConfig.get('default', LANDING_DOMAIN_KEY).catch(() => '')));
  let outcome;
  try {
    if (!host) throw new Error('type the landing domain, for example content360.example.com');
    await tenantConfig.set('default', LANDING_DOMAIN_KEY, host);
    const [account, token] = await Promise.all(['cloudflare_account_id', 'cloudflare_api_token'].map((k) => tenantConfig.get('default', k).catch(() => '')));
    if (!account || !token) throw new Error('save the Cloudflare account ID and API token in the wake-up timer box first');
    const appUrl = String(settings.app.publicBaseUrl || '').replace(/\/+$/, '');
    if (!appUrl) throw new Error('this server has no public address (PUBLIC_BASE_URL)');
    const pages = renderLanding({ email: await contactEmail() });
    await call(landingRequests.putScript(String(account).trim(), String(token).trim(), name, { appUrl, pages }));
    let zoneId = '';
    for (const z of zoneCandidates(host)) {
      const found = await call(landingRequests.findZone(String(token).trim(), z)).catch(() => null);
      const hit = found && (found.result || [])[0];
      if (hit) { zoneId = hit.id; break; }
    }
    // Without Zone: Read the zone is not found; Cloudflare also takes its name.
    const zoneName = zoneId ? '' : zoneCandidates(host).slice(-1)[0];
    await call(landingRequests.putDomain(String(account).trim(), String(token).trim(), { hostname: host, service: name, zoneId, zoneName }))
      .catch((err) => { throw new Error(`the Worker is up, but the domain was not attached: ${err.message}. If ${host} still has an old DNS record (the Railway one), delete it in Cloudflare DNS and deploy again.`); });
    outcome = { ok: true, at, worker: name, domain: host, pages: Object.keys(pages).length };
    log.info(outcome, 'landing deployed to Cloudflare');
  } catch (err) {
    outcome = { ok: false, at, worker: name, domain: host, message: err.message };
    log.warn(outcome, 'landing deploy failed');
  }
  await tenantConfig.set('default', LANDING_DEPLOY_KEY, JSON.stringify(outcome)).catch(() => {});
  cache = { at: 0, domain: '' };
  return status();
}

export async function status() {
  let d = null;
  try { d = JSON.parse((await tenantConfig.get('default', LANDING_DEPLOY_KEY)) || 'null'); } catch { d = null; }
  const domain = (await tenantConfig.get('default', LANDING_DOMAIN_KEY).catch(() => '')) || '';
  const text = !d
    ? '🟡 Not on Cloudflare yet: the pages are served by this app.'
    : d.ok
      ? `🟢 ${d.pages} pages live on https://${d.domain}, deployed ${formatIst(d.at)} IST. This app now sends its own home page there.`
      : `🔴 ${d.message} (tried ${formatIst(d.at)} IST)`;
  return { ok: !!(d && d.ok), text, domain };
}

let cache = { at: 0, domain: '' };

/** The landing domain once a deploy has worked, else ''. Read at most once a minute. */
export async function liveDomain() {
  if (Date.now() - cache.at < 60000) return cache.domain;
  let domain = '';
  try {
    const d = JSON.parse((await tenantConfig.get('default', LANDING_DEPLOY_KEY)) || 'null');
    domain = d && d.ok ? cleanDomain(d.domain) : '';
  } catch { domain = ''; }
  cache = { at: Date.now(), domain };
  return domain;
}

export default { deploy, status, liveDomain };
