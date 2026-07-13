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
import * as tenantSettings from '../core/tenantSettings.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.post('/webhook/pfm-result', async (req, res) => {
    res.status(200).json({ accepted: true });
    if (!(await tenantSettings.moduleEnabled(req.tenantId, 'delivery'))) return;
    delivery
      .recordResult({ tenantId: req.tenantId, event: req.body || {} })
      .catch((err) => req.log.error({ err: err.message }, 'pfm-result processing failed'));
  });

  cron.schedule(
    '30 8 * * *',
    async () => {
      if (!(await tenantSettings.moduleEnabled('default', 'delivery'))) return;
      delivery.sendGitaReport({ tenantId: 'default' }).catch((e) => log.error({ err: e.message }, 'gita report failed'));
    },
    { timezone: ZONE },
  );
  cron.schedule(
    '0 9 * * *',
    async () => {
      if (!(await tenantSettings.moduleEnabled('default', 'delivery'))) return;
      delivery.sendVidapulseReport({ tenantId: 'default' }).catch((e) => log.error({ err: e.message }, 'vidapulse report failed'));
    },
    { timezone: ZONE },
  );

  log.info('delivery reports scheduled 08:30 & 09:00 ' + ZONE);
}

export default { register };
