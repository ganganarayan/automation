/**
 * Module: instances (runtime execution records).
 *
 * Purpose:      Read access to pipeline instances. Slice 1 exposes a JSON list
 *               (the posted-log / instances table UI and the review pages land in
 *               later slices); this also verifies the table + repository on a
 *               deploy.
 * Responsibility: HTTP + auth wiring; logic in instanceService.
 * Dependencies: instanceService, accessService.
 *
 * Routes: GET /api/v1/admin/instances        compact rows (posted log feed)
 *         GET /api/v1/admin/instances/:id     one instance with cost breakdown
 */
import * as instances from '../services/instanceService.js';
import { costBreakdown, sumInstanceCost } from '../utils/instanceSpec.js';
import { keyOk } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/instances', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const rows = await instances.logRows({ tenantId: req.tenantId });
      res.json({ instances: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/instances/:id', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const row = await instances.get(req.params.id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const steps = instances.parseSteps(row);
      res.json({ instance: { ...row, steps }, cost: { total: sumInstanceCost(steps), byStep: costBreakdown(steps) } });
    } catch (err) {
      next(err);
    }
  });

  log.info('instances routes registered');
}

export default { register };
