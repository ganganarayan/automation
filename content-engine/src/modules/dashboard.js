/**
 * Module: operations dashboard.
 *
 * Purpose:      Serve the single-page dashboard.
 * Responsibility: HTTP wiring; rendering lives in dashboardService so it can be
 *               extracted into a standalone Admin UI later.
 * Dependencies: dashboardService.
 *
 * Route: GET /api/v1/dashboard
 */
import * as dashboard from '../services/dashboardService.js';

export function register(ctx) {
  const { router, log } = ctx;
  router.get('/dashboard', async (req, res, next) => {
    try {
      res.type('html').send(await dashboard.render(req.tenantId));
    } catch (err) {
      next(err);
    }
  });
  log.info('dashboard route registered');
}

export default { register };
