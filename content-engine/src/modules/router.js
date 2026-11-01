/**
 * Module: daily post router (wake/sleep).
 *
 * Purpose:      The wake entry point for the daily router: decide tomorrow's
 *               lane per active funnel and line up what is needed (today:
 *               Lane 3 image posts with their approval emails). Each tenant
 *               sets the time in Setup → Settings → Daily schedule (IST),
 *               default 16:00. GitHub Actions (.github/workflows/wake.yml)
 *               pings it; the app does the work under the heartbeat, then may
 *               sleep. On an always-on host (SCHEDULER_MODE=internal) an
 *               in-process 15-minute cron does the same.
 * Responsibility:
 *               - HTTP: POST /api/v1/jobs/router-check (admin-guarded, 202 +
 *                 async, idempotent per funnel + post date). A plain ping runs
 *                 only the tenants whose router_check_time is due (within the
 *                 last 30 minutes, IST). ?all=1 runs every tenant; ?retry=1
 *                 re-decides days recorded as 'none' (every tenant); ?funnel=ID
 *                 limits the run to one funnel.
 *               - Wire the image lane: approve / rework handlers for its
 *                 approval emails, and the post check's "went live" hook that
 *                 marks the sheet row Posted.
 * Dependencies: routerService, imageLaneService, approvalService,
 *               readyPostService, wakeScheduleService, settings, node-cron,
 *               auth middleware.
 */
import cron from 'node-cron';
import * as routerService from '../services/routerService.js';
import * as wakeSchedule from '../services/wakeScheduleService.js';
import { settings } from '../settings/index.js';
import * as imageLane from '../services/imageLaneService.js';
import * as approvalService from '../services/approvalService.js';
import * as readyPost from '../services/readyPostService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  approvalService.onKind(imageLane.KIND, {
    onApprove: (a) => imageLane.approve(a),
    onRework: (a, note) => imageLane.rework(a, note),
  });
  readyPost.onPosted((row, info) => imageLane.onPosted(row, info));

  router.post('/jobs/router-check', requireAdminKey, async (req, res, next) => {
    try {
      const yes = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
      const retryNone = yes(req.query.retry);
      const funnelId = req.query.funnel ? Number(req.query.funnel) : null;
      // A plain wake ping: only the tenants whose daily check time is due.
      const tenantIds = yes(req.query.all) || retryNone || funnelId ? null : await wakeSchedule.dueTenants();
      res.status(202).json({ accepted: true, retry: retryNone, funnel: funnelId, tenants: tenantIds || 'all' });
      if (tenantIds && !tenantIds.length) return log.info('router check: no tenant due now');
      routerService.runCheck({ retryNone, funnelId, tenantIds, log }).catch((e) => log.error({ err: e.message }, 'router check failed'));
    } catch (err) {
      next(err);
    }
  });

  // Always-on host: the same due test every 15 minutes (router_days de-dupes
  // a second hit inside the 30-minute window).
  if (settings.schedulerInternal) {
    cron.schedule('*/15 * * * *', async () => {
      try {
        const tenantIds = await wakeSchedule.dueTenants();
        if (tenantIds.length) await routerService.runCheck({ tenantIds, log });
      } catch (err) {
        log.warn({ err: err.message }, 'scheduled router check failed');
      }
    });
  }

  log.info('daily router routes registered (POST /jobs/router-check)');
}

export default { register };
