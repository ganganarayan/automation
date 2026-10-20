/**
 * Module: video scheduler (wake/sleep).
 *
 * Purpose:      The external cron's wake entry point for the VIDEO pipeline:
 *               decide which active funnels are due now and create one pipeline
 *               instance per due funnel, scheduled for its next publish time.
 *               Railway sleeps the idle service; GitHub Actions
 *               (.github/workflows/run-due.yml) pings this ~just before each
 *               funnel's generate time to wake it, do the work, then sleep.
 * Responsibility:
 *               - HTTP: POST /api/v1/jobs/run-due-video (admin-guarded, 202 + async).
 *               - For each due funnel, idempotently create an instance at
 *                 script_review with scheduled_for = target post datetime.
 *               The two review checkpoints (slice 4) and the stage workers
 *               (slice 5) attach at the SEAM marked below.
 * Dependencies: funnelsRepository, instanceRepository, instanceService,
 *               utils/videoSchedule, utils/time, auth middleware.
 *
 * Route: POST /api/v1/jobs/run-due-video?window=15
 *
 * NOTE: the legacy image poster already owns POST /jobs/run-due (funnelPosters),
 * so the video waker uses a distinct path to avoid shadowing it. This module is
 * always enabled (like instances / image-gate) so the route mounts regardless of
 * the gated MODULE_VIDEO_PIPELINE flag.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as instanceService from '../services/instanceService.js';
import * as stageRunner from '../services/stageRunnerService.js';
import { decideFunnelRun } from '../utils/videoSchedule.js';
import { nowIst, formatIst } from '../utils/time.js';
import { requireAdminKey } from '../middleware/auth.js';

/**
 * Create instances for every active funnel due within ±windowMin of its
 * generate_time. Idempotent: a funnel that already has a live instance for the
 * target post date is skipped, so a double-ping never double-creates.
 * Returns a summary { checked, created, skipped }.
 */
export async function runDueVideo({ windowMin = 15, now = nowIst(), log } = {}) {
  const active = await funnels.listActive();
  const created = [];
  const skipped = [];

  for (const funnel of active) {
    try {
      const cfg = await funnels.resolve(funnel);
      const { due, scheduledFor, dateKey } = decideFunnelRun({
        generateTime: cfg.generateTime,
        generateDays: cfg.generateDays,
        publishTime: cfg.publishTime,
        now,
        forwardMin: windowMin,
        backMin: windowMin,
      });
      if (!due) continue;

      if (await instanceRepo.existsForFunnelOnDate(funnel.id, dateKey, funnel.tenant_id)) {
        skipped.push({ funnel: funnel.name, postDate: dateKey });
        log?.info({ funnel: funnel.name, postDate: dateKey }, 'run-due-video: live instance exists, skipping');
        continue;
      }

      const instance = await instanceService.createForFunnel({
        tenantId: funnel.tenant_id,
        funnel,
        title: `${funnel.name} — ${formatIst(scheduledFor, { withTime: false })}`,
        scheduledFor: scheduledFor.toJSDate(),
      });
      created.push({ funnel: funnel.name, instanceId: instance.id, scheduledFor: scheduledFor.toISO() });
      log?.info(
        { funnel: funnel.name, instance: instance.id, scheduledFor: scheduledFor.toISO() },
        'run-due-video: instance created (script_review)',
      );

      // Slice 5: generate the script, then open the script-review checkpoint
      // (slice 4). Async + self-contained — a failure marks the instance failed,
      // never the whole run. The remaining stages run after script approval.
      stageRunner.runScriptAndReview({ instanceId: instance.id }).catch((e) =>
        log?.error({ err: e.message, instance: instance.id }, 'run-due-video: script+review failed'),
      );
    } catch (err) {
      log?.error({ err: err.message, funnel: funnel.name }, 'run-due-video: funnel failed');
    }
  }

  return { checked: active.length, created, skipped };
}

export function register(ctx) {
  const { router, log } = ctx;

  // External wake: create instances for funnels due within ±window minutes
  // (default 15). 202 + async, matching the other /jobs routes.
  router.post('/jobs/run-due-video', requireAdminKey, async (req, res, next) => {
    try {
      const windowMin = Math.max(1, Number(req.query.window || 15));
      res.status(202).json({ accepted: true, window: windowMin });
      runDueVideo({ windowMin, log }).catch((e) => log.error({ err: e.message }, 'run-due-video failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('video scheduler routes registered (POST /jobs/run-due-video)');
}

export default { register, runDueVideo };
