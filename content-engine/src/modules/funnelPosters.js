/**
 * Module: funnel image posters.
 *
 * Purpose:      Run the daily image poster for every active funnel and wire the
 *               approve/rework handlers. Replaces the hardcoded Gita/VidaPulse
 *               poster modules — those are now funnels.
 * Responsibility: lifecycle + registration; logic in funnelPosterService.
 * Dependencies: node-cron, funnelPosterService, approvalService, admin auth.
 *
 * Route: POST /api/v1/jobs/funnel-posters (manual run of all active funnels).
 */
import cron from 'node-cron';
import * as poster from '../services/funnelPosterService.js';
import * as approvalService from '../services/approvalService.js';
import { requireAdminKey } from '../middleware/auth.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, log } = ctx;

  approvalService.onKind(poster.KIND, {
    onApprove: (a) => poster.publish(a),
    onRework: (a, note) => poster.rework(a, note),
  });

  cron.schedule(
    '0 22 * * *',
    () => poster.runAllActive().catch((e) => log.error({ err: e.message }, 'funnel posters cron failed')),
    { timezone: ZONE },
  );

  router.post('/jobs/funnel-posters', requireAdminKey, async (_req, res, next) => {
    try {
      res.status(202).json({ accepted: true });
      poster.runAllActive().catch((e) => log.error({ err: e.message }, 'manual funnel run failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('funnel posters scheduled 22:00 ' + ZONE);
}

export default { register };
