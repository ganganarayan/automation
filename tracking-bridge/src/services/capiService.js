/**
 * Razorpay -> Meta CAPI relay orchestration.
 *
 * Purpose:      Turn a verified payment.captured webhook into a fully-matched
 *               Meta Purchase event and email a confirmation.
 * Responsibility:
 *               - Extract the purchase, enrich via Assess360, build the event,
 *                 POST to Meta, and email a match-signal summary.
 *               - Never throw on downstream (Meta/enrichment) errors.
 * Dependencies: capiBuilder, providers (meta, enrichment, mail), settings,
 *               eventLog.
 */
import { buildPurchaseEvent, extractPurchase } from './capiBuilder.js';
import * as eventLog from '../repositories/eventLogRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { createMetaProvider } from '../providers/metaProvider.js';
import { createAssess360Provider } from '../providers/enrichmentProvider.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

/**
 * Process a verified payment.captured payload.
 * @param {object} args - { tenantId, providers, payload }
 */
export async function process({ tenantId = 'default', providers, payload }) {
  const log = childLogger({ module: 'razorpayCapi', tenant_id: tenantId });
  const purchase = extractPurchase(payload);
  if (!purchase.paymentId) {
    log.warn('payment.captured missing payment id; skipping');
    return;
  }

  // Resolve per-tenant config and build the Meta/enrichment clients from it.
  const resolved = await tenantSettings.forTenant(tenantId);
  const meta = createMetaProvider(resolved.meta, log);
  const enrichmentClient = createAssess360Provider(resolved.assess360, log);

  const enrichment = await enrichmentClient.match({ email: purchase.email, phone: purchase.phone });

  const { event, matchSignals } = buildPurchaseEvent({
    purchase,
    enrichment,
    config: { contentName: resolved.meta.contentName, eventSourceUrl: resolved.meta.eventSourceUrl },
  });

  let metaResult = { ok: false };
  try {
    metaResult = await meta.sendEvent(event, { testEventCode: resolved.meta.testEventCode || undefined });
  } catch (err) {
    log.warn({ err: err.message }, 'meta CAPI send failed (continuing)');
    metaResult = { ok: false, error: err.message };
  }

  await eventLog.append({
    tenantId,
    eventType: 'capi.purchase',
    payload: { paymentId: purchase.paymentId, matchSignals, metaStatus: metaResult.status ?? null },
  });

  // Confirmation email.
  const events_received = metaResult.data?.events_received;
  const fbtrace = metaResult.data?.fbtrace_id;
  const summary =
    `Purchase ${purchase.paymentId} (INR ${purchase.amount})\n\n` +
    `Match signals: ${Object.entries(matchSignals).map(([k, v]) => `${k}=${v ? 'Y' : 'N'}`).join(' ')}\n\n` +
    `Meta: ${metaResult.ok ? 'ok' : 'error'}` +
    (events_received !== undefined ? ` events_received=${events_received}` : '') +
    (fbtrace ? ` fbtrace=${fbtrace}` : '') +
    (metaResult.error ? ` error=${metaResult.error}` : '');

  if (settings.alerts.email) {
    await providers.mail.send({
      to: settings.alerts.email,
      subject: `CAPI Purchase ${metaResult.ok ? 'sent' : 'ERROR'} — ${purchase.paymentId}`,
      text: summary,
    });
  }
  log.info({ paymentId: purchase.paymentId, metaOk: metaResult.ok, matchSignals }, 'capi purchase processed');
}

export default { process };
