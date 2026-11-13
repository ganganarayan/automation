/**
 * Delivery log and failure alerts.
 *
 * Purpose:      Record Post-for-Me delivery results and alert on failures.
 * Responsibility:
 *               - recordResult(payload): map account -> {platform, brand, name},
 *                 insert a log row, and email an alert on failure.
 * Dependencies: pfmDeliveryLogRepository, providers (mail), time utils.
 */
import * as deliveryLog from '../repositories/pfmDeliveryLogRepository.js';
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

export default { recordResult };
