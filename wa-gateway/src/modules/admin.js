/**
 * Module: admin.
 *
 * Purpose:      Operational endpoints under a common /admin namespace, guarded
 *               by the admin key.
 * Responsibility: expose queue purge/depth, jobs, events, module status, config.
 * Dependencies: queueService, jobRepository, eventLogRepository, moduleRegistry.
 *
 * Routes (all require X-Admin-Key):
 *   POST /api/v1/admin/queue/purge   ?status=QUEUED
 *   GET  /api/v1/admin/queue
 *   GET  /api/v1/admin/jobs
 *   GET  /api/v1/admin/events
 *   GET  /api/v1/admin/modules
 *   GET  /api/v1/admin/config
 */
import * as queue from '../core/queueService.js';
import * as jobRepo from '../repositories/jobRepository.js';
import * as eventLog from '../repositories/eventLogRepository.js';
import { requireAdminKey } from '../middleware/auth.js';
import { settings } from '../settings/index.js';

export function register(ctx) {
  const { router, registry } = ctx;
  const admin = router; // routes namespaced with /admin below

  admin.post('/admin/queue/purge', requireAdminKey, async (req, res, next) => {
    try {
      const status = (req.query.status || 'QUEUED').toString();
      const count = await queue.purge({ tenantId: req.tenantId, status });
      res.json({ purged: count, status });
    } catch (err) {
      next(err);
    }
  });

  admin.get('/admin/queue', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ depth: await queue.depth({ tenantId: req.tenantId }) });
    } catch (err) {
      next(err);
    }
  });

  admin.get('/admin/jobs', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ jobs: await jobRepo.recent({ tenantId: req.tenantId, limit: 100 }) });
    } catch (err) {
      next(err);
    }
  });

  admin.get('/admin/events', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ events: await eventLog.recent({ tenantId: req.tenantId, limit: 100 }) });
    } catch (err) {
      next(err);
    }
  });

  admin.get('/admin/modules', requireAdminKey, (_req, res) => {
    res.json({ modules: registry.status() });
  });

  admin.get('/admin/config', requireAdminKey, (_req, res) => {
    // Non-secret operational settings only.
    res.json({
      service: settings.service,
      tz: settings.tz,
      dispatcher: settings.dispatcher,
      modules: settings.modules,
    });
  });
}

export default { register };
