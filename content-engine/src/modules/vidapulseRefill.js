/**
 * Module: VidaPulse content refill.
 *
 * Purpose:      A manual run of the VidaPulse refill watchdog. The 09:00 IST
 *               schedule is retired: funnels refill their own sheets through
 *               the daily router (Lane 3), and the Settings toggle is gone.
 * Responsibility: route only; logic in refillService.
 * Dependencies: refillService, admin auth.
 */
import * as refill from '../services/refillService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  // Manual trigger for operators.
  router.post('/jobs/refill', requireAdminKey, async (req, res, next) => {
    try {
      await refill.run({ tenantId: req.tenantId });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  log.info('vidapulse refill: manual run only (POST /jobs/refill)');
}

export default { register };
