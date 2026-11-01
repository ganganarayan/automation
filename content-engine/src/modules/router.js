/**
 * Module: daily post router (wake/sleep).
 *
 * Purpose:      The 16:00 IST wake entry point for the daily router: decide
 *               tomorrow's lane per active funnel and line up what is needed
 *               (today: Lane 3 image posts with their approval emails).
 *               GitHub Actions (.github/workflows/router-check.yml) pings it;
 *               the app does the work under the heartbeat, then may sleep.
 * Responsibility:
 *               - HTTP: POST /api/v1/jobs/router-check (admin-guarded, 202 +
 *                 async, idempotent per funnel + post date).
 *                 ?retry=1 re-decides days recorded as 'none'; ?funnel=ID
 *                 limits the run to one funnel.
 *               - Wire the image lane: approve / rework handlers for its
 *                 approval emails, and the post check's "went live" hook that
 *                 marks the sheet row Posted.
 * Dependencies: routerService, imageLaneService, approvalService,
 *               readyPostService, auth middleware.
 */
import * as routerService from '../services/routerService.js';
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
      const retryNone = ['1', 'true', 'yes'].includes(String(req.query.retry || '').toLowerCase());
      const funnelId = req.query.funnel ? Number(req.query.funnel) : null;
      res.status(202).json({ accepted: true, retry: retryNone, funnel: funnelId });
      routerService.runCheck({ retryNone, funnelId, log }).catch((e) => log.error({ err: e.message }, 'router check failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('daily router routes registered (POST /jobs/router-check)');
}

export default { register };
