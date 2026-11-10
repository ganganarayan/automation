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
import * as tenantRepo from '../repositories/tenantRepository.js';
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
      for (const tenantId of await tenantRepo.activeIds().catch(() => ['default'])) {
        if (!(await tenantSettings.moduleEnabled(tenantId, 'delivery'))) continue;
        await delivery.sendGitaReport({ tenantId }).catch((e) => log.error({ err: e.message, tenantId }, 'gita report failed'));
      }
    },
    { timezone: ZONE },
  );
  cron.schedule(
    '0 9 * * *',
    async () => {
      for (const tenantId of await tenantRepo.activeIds().catch(() => ['default'])) {
        if (!(await tenantSettings.moduleEnabled(tenantId, 'delivery'))) continue;
        await delivery.sendVidapulseReport({ tenantId }).catch((e) => log.error({ err: e.message, tenantId }, 'vidapulse report failed'));
      }
    },
    { timezone: ZONE },
  );

  log.info('delivery reports scheduled 08:30 & 09:00 ' + ZONE);
}

export default { register };
