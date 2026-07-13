/**
 * Delivery log, alerts, and daily reports.
 *
 * Purpose:      Record Post-for-Me delivery results, alert on failures, and send
 *               the two daily delivery reports.
 * Responsibility:
 *               - recordResult(payload): map account -> {platform, brand, name},
 *                 insert a log row, and email an alert on failure.
 *               - sendGitaReport / sendVidapulseReport: build and email reports.
 * Dependencies: pfmDeliveryLogRepository, report builders, providers (mail),
 *               tenantSettings, time utils.
 */
import * as deliveryLog from '../repositories/pfmDeliveryLogRepository.js';
import { buildGitaReport, buildVidapulseReport } from '../utils/report.js';
import { buildProviders } from './providerFactory.js';
import { todayKeyIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

/**
 * Record a Post-for-Me "social.post.result.created" webhook.
 * @param {object} args - { tenantId, providers, event }
 */
export async function recordResult({ tenantId = 'default', event }) {
  const log = childLogger({ module: 'delivery', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const map = resolved.postforme.accountMap || {};

  // Post for Me result shape is tolerant: pull from common locations.
  const data = event?.data || event || {};
  const accountId = data.social_account_id || data.account_id || data.accountId || '';
  const meta = map[accountId] || {};
  const success = data.success ?? data.status === 'success' ?? false;
  const error = data.error || data.error_message || null;
  const postId = data.social_post_id || data.post_id || data.postId || '';

  const row = await deliveryLog.insert({
    tenantId,
    brand: meta.brand || data.brand || 'unknown',
    accountId,
    postId,
    platform: meta.platform || data.platform || 'unknown',
    accountName: meta.account_name || meta.name || accountId,
    success: !!success,
    error,
    dayIst: todayKeyIst(),
  });

  if (!success) {
    await providers.mail.send({
      to: resolved.emails.report,
      subject: `${row.brand} post FAILED on ${row.platform}`,
      text: `Post ${postId} on account ${accountId} (${row.platform}) failed.\n\nError: ${error || 'unknown'}`,
    });
    log.warn({ accountId, platform: row.platform }, 'delivery failure alert sent');
  }
  return row;
}

/** Cron 08:30 IST: Gita 7/7 report. */
export async function sendGitaReport({ tenantId = 'default' }) {
  const log = childLogger({ module: 'delivery', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const day = todayKeyIst();
  const rows = await deliveryLog.forDay({ tenantId, brand: 'gita', dayIst: day });
  const expected = expectedAccounts(resolved.postforme.accountMap, 'gita', resolved.postforme.gitaAccounts);
  const report = buildGitaReport(rows, expected);
  await providers.mail.send({ to: resolved.emails.report, subject: report.subject, text: report.body });
  log.info({ subject: report.subject }, 'gita report sent');
}

/** Cron 09:00 IST: VidaPulse report with 26h staleness check. */
export async function sendVidapulseReport({ tenantId = 'default' }) {
  const log = childLogger({ module: 'delivery', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const rows = await deliveryLog.latest({ tenantId, brand: 'vidapulse', limit: 50 });
  const expected = expectedAccounts(resolved.postforme.accountMap, 'vidapulse', resolved.postforme.vidapulseAccounts);
  const report = buildVidapulseReport(rows, expected, new Date(), 26);
  await providers.mail.send({ to: resolved.emails.approvalVidapulse, subject: report.subject, text: report.body });
  log.info({ subject: report.subject }, 'vidapulse report sent');
}

/** Build the expected-accounts list for a brand from the account map (+ ids). */
function expectedAccounts(accountMap, brand, accountIds = []) {
  const out = [];
  const seen = new Set();
  for (const [id, meta] of Object.entries(accountMap || {})) {
    if ((meta.brand || '').toLowerCase() === brand) {
      out.push({ account_id: id, account_name: meta.account_name || meta.name, platform: meta.platform });
      seen.add(id);
    }
  }
  for (const id of accountIds) {
    if (!seen.has(id)) out.push({ account_id: id, account_name: id, platform: (accountMap?.[id]?.platform) });
  }
  return out;
}

export default { recordResult, sendGitaReport, sendVidapulseReport };
