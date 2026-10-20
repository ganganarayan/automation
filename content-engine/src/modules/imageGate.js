/**
 * Module: images-selectable gate.
 *
 * Purpose:      Register the image_gate approval kind (generate stills -> keep /
 *               regenerate review -> lock the kept set) and expose an admin job
 *               trigger for it.
 * Responsibility: HTTP + registration; logic in imageGateService.
 * Dependencies: imageGateService, approvalService (via the service), admin auth.
 *
 * Routes: POST /api/v1/jobs/image-gate  { funnel_id, topic?, count?, prompts? }
 */
import * as imageGate from '../services/imageGateService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  // Wire approve (lock selection) + rework (regenerate marked) + the review grid.
  imageGate.registerKind();

  router.post('/jobs/image-gate', requireAdminKey, async (req, res, next) => {
    try {
      const funnelId = req.body?.funnel_id;
      if (!funnelId) return res.status(400).json({ error: 'funnel_id required' });
      res.status(202).json({ accepted: true });
      imageGate
        .generateForFunnel({
          tenantId: req.tenantId,
          funnelId,
          topic: req.body?.topic,
          count: req.body?.count,
          prompts: req.body?.prompts,
        })
        .catch((e) => log.error({ err: e.message }, 'image gate job failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('image gate routes registered');
}

export default { register };
