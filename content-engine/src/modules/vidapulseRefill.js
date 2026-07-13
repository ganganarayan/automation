/**
 * Module: VidaPulse content refill.
 *
 * Purpose:      Schedule the 09:00 IST refill watchdog and expose a manual run.
 * Responsibility: lifecycle + route; logic in refillService.
 * Dependencies: node-cron, refillService, admin auth.
 */
import cron from 'node-cron';
import * as refill from '../services/refillService.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { requireAdminKey } from '../middleware/auth.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, providers, log } = ctx;

  cron.schedule(
    '0 9 * * *',
    async () => {
      if (!(await tenantSettings.moduleEnabled('default', 'vidapulseRefill'))) return;
      refill.run({ providers, tenantId: 'default' }).catch((e) => log.error({ err: e.message }, 'refill cron failed'));
    },
    { timezone: ZONE },
  );

  // Manual trigger for operators.
  router.post('/jobs/refill', requireAdminKey, async (req, res, next) => {
    try {
      await refill.run({ providers, tenantId: req.tenantId });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  log.info('vidapulse refill scheduled 09:00 ' + ZONE);
}

export default { register };
