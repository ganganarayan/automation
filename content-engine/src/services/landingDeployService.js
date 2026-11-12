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
  LANDING_DEPLOY_KEY, LANDING_DOMAIN_KEY, LANDING_APP_KEY, renderLanding, cleanDomain, zoneCandidates, landingWorkerName, landingRequests,
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
export async function deploy({ domain = '', appDomain } = {}) {
  const at = new Date().toISOString();
  const name = landingWorkerName(settings.app.publicBaseUrl);
  const host = cleanDomain(domain || (await tenantConfig.get('default', LANDING_DOMAIN_KEY).catch(() => '')));
  let outcome;
  try {
    if (!host) throw new Error('type the landing domain, for example content360.example.com');
    await tenantConfig.set('default', LANDING_DOMAIN_KEY, host);
    const [account, token] = await Promise.all(['cloudflare_account_id', 'cloudflare_api_token'].map((k) => tenantConfig.get('default', k).catch(() => '')));
    if (!account || !token) throw new Error('save the Cloudflare account ID and API token in the wake-up timer box first');
    // Where Sign in and Buy go: the owner's app domain, else this server's own address.
    if (appDomain !== undefined) {
      const typed = String(appDomain || '').trim();
      if (typed && !cleanDomain(typed)) throw new Error('the app address is a domain, for example app.content360.example.com');
      await tenantConfig.set('default', LANDING_APP_KEY, cleanDomain(typed));
    }
    const appHost = cleanDomain(await tenantConfig.get('default', LANDING_APP_KEY).catch(() => ''));
    const appUrl = appHost ? `https://${appHost}` : String(settings.app.publicBaseUrl || '').replace(/\/+$/, '');
    if (!appUrl) throw new Error('this server has no public address (PUBLIC_BASE_URL)');
    const pages = renderLanding({ email: await contactEmail(), origin: `https://${host}` });
    await call(landingRequests.putScript(String(account).trim(), String(token).trim(), name, { appUrl, pages }));
    // Already attached to this Worker (any deploy after the first): nothing to attach.
    const existing = await call(landingRequests.listDomains(String(account).trim(), String(token).trim(), host)).catch(() => null);
    const mine = ((existing && existing.result) || []).find((d) => d.hostname === host);
    if (mine && mine.service !== name) throw new Error(`the pages are up, but ${host} is attached to another Worker (${mine.service}). Remove it there (Workers & Pages, that Worker, Settings, Domains & Routes) and deploy again.`);
    let zoneId = '';
    for (const z of zoneCandidates(host)) {
      const found = await call(landingRequests.findZone(String(token).trim(), z)).catch(() => null);
      const hit = found && (found.result || [])[0];
      if (hit) { zoneId = hit.id; break; }
    }
    // Without Zone: Read the zone is not found; Cloudflare also takes its name.
    const zoneName = zoneId ? '' : zoneCandidates(host).slice(-1)[0];
    if (!mine) await call(landingRequests.putDomain(String(account).trim(), String(token).trim(), { hostname: host, service: name, zoneId, zoneName }))
      .catch((err) => { throw new Error(`the pages are up, but ${host} was not attached: ${err.message}`); });
    outcome = { ok: true, at, worker: name, domain: host, appUrl, pages: Object.keys(pages).length };
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
      ? `🟢 ${d.pages} pages live on https://${d.domain}, deployed ${formatIst(d.at)} IST. Sign in and Buy go to ${d.appUrl || 'this app'}. This app now sends its own home page there.`
      : `🔴 ${d.message} (tried ${formatIst(d.at)} IST)`;
  const appDomain = (await tenantConfig.get('default', LANDING_APP_KEY).catch(() => '')) || '';
  return { ok: !!(d && d.ok), text, domain, appDomain };
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
