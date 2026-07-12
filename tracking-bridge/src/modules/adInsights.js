/**
 * Module: daily Meta ad insights.
 *
 * Purpose:      Schedule the 07:00 IST insights pull and expose a manual run.
 * Responsibility: cron + route; logic in insightsService.
 * Dependencies: node-cron, insightsService.
 *
 * Route: POST /api/v1/jobs/insights (manual backfill/trigger)
 */
import cron from 'node-cron';
import * as insights from '../services/insightsService.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, providers, log } = ctx;

  cron.schedule(
    '0 7 * * *',
    () => insights.run({ tenantId: 'default', providers }).catch((e) => log.error({ err: e.message }, 'insights cron failed')),
    { timezone: ZONE },
  );

  router.post('/jobs/insights', async (req, res, next) => {
    try {
      const result = await insights.run({ tenantId: req.tenantId, providers });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  log.info('ad insights scheduled 07:00 ' + ZONE);
}

export default { register };
