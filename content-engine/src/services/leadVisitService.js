/**
 * Lead visits: DM'd leads who open the landing page.
 *
 * Purpose:      The link in a lead's DM is their own (/api/v1/go/{code}). Opening
 *               it marks them clicked and sends them on to the landing page;
 *               the landing-page script then reports the page view and any form
 *               submit against the same code. On the first click we also try to
 *               put a "Lead · visited site" label on them in the Instagram /
 *               Facebook inbox (best effort — Meta documents inbox labels for
 *               Messenger; for Instagram the outcome is recorded on the lead).
 * Responsibility: Orchestration; pure link logic in utils/leadLinkSpec.
 * Dependencies: capturedLeadsRepository, tenantConfigRepository, captureConfig,
 *               httpClient, settings, logger.
 */
import * as leads from '../repositories/capturedLeadsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as captureConfig from './captureConfig.js';
import { request } from '../core/httpClient.js';
import { trackedUrl, destinationUrl, validCode, cleanForm } from '../utils/leadLinkSpec.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'leadVisit' });
const GRAPH = 'https://graph.facebook.com/v21.0';
export const LEAD_LABEL = 'Lead · visited site';

/** For captureService: the lead's personal link for url (and remember where it goes). */
export async function trackLink(lead, url) {
  const link = trackedUrl(settings.publicBaseUrl, lead && lead.visit_code);
  if (!link || !destinationUrl(url, lead.visit_code)) return url;
  await leads.setVisitTarget(lead.id, url);
  return link;
}

/** /go/{code}: count the click and return where to send them ('' = unknown code). */
export async function onClick(code) {
  if (!validCode(code)) return '';
  const lead = await leads.markClicked(code).catch(() => null);
  if (!lead || !lead.visit_target) return '';
  if (lead.first_click) labelInInbox(lead).catch((err) => log.warn({ err: err.message, lead: lead.id }, 'inbox label failed'));
  log.info({ lead: lead.id, platform: lead.platform, clicks: lead.click_count }, 'lead opened their link');
  return destinationUrl(lead.visit_target, code, { platform: lead.platform, lane: lead.lane });
}

/** The landing-page script: { lc, type: 'view' | 'form', fields }. */
export async function onPageEvent(body = {}) {
  const code = String(body.lc || '');
  if (!validCode(code)) return false;
  const form = body.type === 'form' ? cleanForm(body.fields) : null;
  const row = await leads.markVisit(code, { form });
  return !!row;
}

async function graph(path, token, { method = 'GET', body } = {}) {
  const res = await request(`${GRAPH}${path}`, {
    method, body, label: 'leadVisit.label', log, retries: 0,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const e = res.data && res.data.error;
    throw new Error(e ? `${e.code ?? res.status}: ${e.message}` : `graph ${res.status}`);
  }
  return res.data || {};
}

/** The Page's "Lead · visited site" label id (made once, kept in tenant_config). */
async function labelId(tenantId, token) {
  const page = await graph('/me?fields=id', token);
  const key = `inbox_lead_label:${page.id}`;
  const saved = await tenantConfig.get(tenantId, key).catch(() => '');
  if (saved) return saved;
  const list = await graph(`/${encodeURIComponent(page.id)}/custom_labels?fields=page_label_name&limit=100`, token);
  let id = ((list.data || []).find((l) => l.page_label_name === LEAD_LABEL) || {}).id;
  if (!id) id = (await graph(`/${encodeURIComponent(page.id)}/custom_labels`, token, { method: 'POST', body: { page_label_name: LEAD_LABEL } })).id;
  if (!id) throw new Error('Meta returned no label id');
  await tenantConfig.set(tenantId, key, id);
  return id;
}

/** Best effort: label the person in the Instagram / Facebook inbox; the outcome is kept on the lead. */
async function labelInInbox(lead) {
  const cfg = await captureConfig.forTenant(lead.tenant_id);
  const token = captureConfig.tokenFor(cfg, lead.account_id);
  if (!token || !lead.commenter_id) {
    await leads.setLabelStatus(lead.id, `failed: ${token ? 'no person id' : 'no Meta token for this account'}`);
    return;
  }
  try {
    const id = await labelId(lead.tenant_id, token);
    await graph(`/${encodeURIComponent(id)}/label`, token, { method: 'POST', body: { user: lead.commenter_id } });
    await leads.setLabelStatus(lead.id, 'ok');
  } catch (err) {
    await leads.setLabelStatus(lead.id, `failed: ${err.message}`);
  }
}

export default { trackLink, onClick, onPageEvent, LEAD_LABEL };
