/**
 * Module: delivery log and failure alerts.
 *
 * Purpose:      Receive Post-for-Me result webhooks. (The old 08:30 Gita and
 *               09:00 VidaPulse report emails were removed 13-11-2026: they
 *               counted a legacy brand tag before the evening post, so they
 *               always said "no posts". The daily digest covers reporting.)
 * Responsibility: HTTP wiring; logic in deliveryService.
 * Dependencies: deliveryService.
 *
 * Routes: POST /api/v1/webhook/pfm-result
 */
import * as delivery from '../services/deliveryService.js';
import * as tenantSettings from '../core/tenantSettings.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.post('/webhook/pfm-result', async (req, res) => {
    res.status(200).json({ accepted: true });
    if (!(await tenantSettings.moduleEnabled(req.tenantId, 'delivery'))) return;
    delivery
      .recordResult({ tenantId: req.tenantId, event: req.body || {} })
      .catch((err) => req.log.error({ err: err.message }, 'pfm-result processing failed'));
  });

  log.info('delivery log on: Post for Me results recorded, failures emailed');
}

export default { register };
