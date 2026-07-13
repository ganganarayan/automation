/**
 * Module: admin.
 *
 * Purpose:      Operational endpoints under /api/v1/admin, guarded by the admin
 *               key.
 * Responsibility: expose PFM account listing, jobs, events, approvals, module
 *               status, and non-secret config.
 * Dependencies: providers (publish), repositories, moduleRegistry, admin auth.
 */
import * as jobRepo from '../repositories/jobRepository.js';
import * as eventLog from '../repositories/eventLogRepository.js';
import * as approvals from '../repositories/approvalRepository.js';
import { requireAdminKey } from '../middleware/auth.js';
import { buildProviders } from '../services/providerFactory.js';
import { settings } from '../settings/index.js';

export function register(ctx) {
  const { router } = ctx;

  router.get('/admin/pfm-accounts', requireAdminKey, async (req, res, next) => {
    try {
      const providers = await buildProviders(req.tenantId);
      res.json(await providers.publish.listAccounts());
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/jobs', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ jobs: await jobRepo.recent({ tenantId: req.tenantId, limit: 100 }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/events', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ events: await eventLog.recent({ tenantId: req.tenantId, limit: 100 }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/approvals', requireAdminKey, async (req, res, next) => {
    try {
      res.json({ approvals: await approvals.recent({ tenantId: req.tenantId, limit: 50 }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/modules', requireAdminKey, (_req, res) => {
    res.json({ modules: ctx.registry.status() });
  });

  router.get('/admin/config', requireAdminKey, (_req, res) => {
    res.json({ service: settings.service, tz: settings.tz, modules: settings.modules });
  });
}

export default { register };
