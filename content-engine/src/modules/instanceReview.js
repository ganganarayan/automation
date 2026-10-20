/**
 * Module: instance review (two checkpoints + rework).
 *
 * Purpose:      Register the instance_review approval kind (script review, final
 *               review, correction rework) and expose a trigger that sends a
 *               checkpoint review for an existing instance.
 * Responsibility: HTTP + registration; logic in instanceReviewService.
 * Dependencies: instanceReviewService, approvalService (via the service), auth.
 *
 * Route: POST /api/v1/jobs/instance-review  { instance_id, checkpoint? }
 *        checkpoint = script (default) | final. 202 + async, like the other jobs.
 *
 * This endpoint is both a manual trigger (review the script/reel of an instance
 * now) and the seam slice 5's stage workers call once a script or reel exists.
 */
import * as review from '../services/instanceReviewService.js';
import * as stageRunner from '../services/stageRunnerService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  // Wire approve (advance / post+lock) + rework (correction, new round) + the
  // hosted review page (script text, or the reel via Drive /preview).
  review.registerKind();
  // Slice 5: let review decisions drive generation (run stages / post / regen).
  stageRunner.registerPipeline();

  router.post('/jobs/instance-review', requireAdminKey, async (req, res, next) => {
    try {
      const instanceId = req.body?.instance_id || req.query.instance_id;
      const checkpoint = String(req.body?.checkpoint || req.query.checkpoint || 'script');
      if (!instanceId) return res.status(400).json({ error: 'instance_id required' });
      res.status(202).json({ accepted: true, checkpoint });
      review
        .requestReview({ tenantId: req.tenantId, instanceId, checkpoint })
        .catch((e) => log.error({ err: e.message }, 'instance-review send failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('instance review routes registered (POST /jobs/instance-review)');
}

export default { register };
