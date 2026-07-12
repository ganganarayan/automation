/**
 * Module: AI image factory.
 *
 * Purpose:      Expose the factory job trigger (and an optional cron).
 * Responsibility: HTTP + cron wiring; logic in imageFactoryService.
 * Dependencies: imageFactoryService, admin auth.
 *
 * Route: POST /api/v1/jobs/image-factory
 */
import * as factory from '../services/imageFactoryService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, providers, log } = ctx;

  router.post('/jobs/image-factory', requireAdminKey, async (req, res, next) => {
    try {
      const result = await factory.run({ providers, tenantId: req.tenantId });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  log.info('image factory route registered');
}

export default { register };
