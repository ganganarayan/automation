/**
 * Module: unified operations dashboard.
 *
 * Purpose:      Serve the single-page dashboard covering all three services.
 * Responsibility: HTTP wiring + an optional access gate; rendering lives in
 *               dashboardService so it can be extracted into a standalone Admin
 *               UI later.
 * Dependencies: dashboardService, settings.
 *
 * Route: GET /api/v1/dashboard
 *
 * Access: email + password sign-in (see accessService); signed-out visits go
 * to /api/v1/admin/login and come back here.
 */
import * as dashboard from '../services/dashboardService.js';
import { gateState } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/dashboard', async (req, res, next) => {
    try {
      const state = await gateState(req);
      if (state === 'change') return res.redirect('/api/v1/admin/password?next=%2Fapi%2Fv1%2Fdashboard');
      if (state !== 'ok') return res.redirect('/api/v1/admin/login?next=%2Fapi%2Fv1%2Fdashboard');
      res.type('html').send(await dashboard.render(req.tenantId, {}));
    } catch (err) {
      next(err);
    }
  });

  log.info('unified dashboard route registered');
}

export default { register };
