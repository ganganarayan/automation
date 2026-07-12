/**
 * Module: video pipeline (full + simple).
 *
 * Purpose:      Expose manual job triggers and wire approve handlers for both
 *               the full voiceover pipeline (off by default) and the simple reel
 *               poster.
 * Responsibility: HTTP + registration; logic in videoService.
 * Dependencies: videoService, approvalService, admin auth.
 *
 * Routes: POST /api/v1/jobs/video, POST /api/v1/jobs/video-simple
 */
import * as video from '../services/videoService.js';
import * as approvalService from '../services/approvalService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, providers, log } = ctx;
  const deps = { providers };

  approvalService.onKind(video.FULL_KIND, { onApprove: (a) => video.publishFull(a, deps) });
  approvalService.onKind(video.SIMPLE_KIND, { onApprove: (a) => video.publishSimple(a, deps) });

  router.post('/jobs/video', requireAdminKey, async (req, res, next) => {
    try {
      res.status(202).json({ accepted: true });
      video.runFull({ providers, tenantId: req.tenantId }).catch((e) => log.error({ err: e.message }, 'video full failed'));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/video-simple', requireAdminKey, async (req, res, next) => {
    try {
      res.status(202).json({ accepted: true });
      video.runSimple({ providers, tenantId: req.tenantId }).catch((e) => log.error({ err: e.message }, 'video simple failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('video pipeline routes registered');
}

export default { register };
