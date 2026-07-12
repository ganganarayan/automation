/**
 * Module: delivery log, alerts, and daily reports.
 *
 * Purpose:      Receive Post-for-Me result webhooks and schedule the two daily
 *               reports.
 * Responsibility: HTTP + cron wiring; logic in deliveryService.
 * Dependencies: node-cron, deliveryService.
 *
 * Routes: POST /api/v1/webhook/pfm-result
 */
import cron from 'node-cron';
import * as delivery from '../services/deliveryService.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, providers, log } = ctx;

  router.post('/webhook/pfm-result', (req, res) => {
    res.status(200).json({ accepted: true });
    delivery
      .recordResult({ tenantId: req.tenantId, providers, event: req.body || {} })
      .catch((err) => req.log.error({ err: err.message }, 'pfm-result processing failed'));
  });

  cron.schedule(
    '30 8 * * *',
    () => delivery.sendGitaReport({ tenantId: 'default', providers }).catch((e) => log.error({ err: e.message }, 'gita report failed')),
    { timezone: ZONE },
  );
  cron.schedule(
    '0 9 * * *',
    () => delivery.sendVidapulseReport({ tenantId: 'default', providers }).catch((e) => log.error({ err: e.message }, 'vidapulse report failed')),
    { timezone: ZONE },
  );

  log.info('delivery reports scheduled 08:30 & 09:00 ' + ZONE);
}

export default { register };
