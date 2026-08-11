/**
 * Module: funnel posters (scheduler).
 *
 * Purpose:      Run each active funnel at its own configured time and days, and
 *               wire the approve/rework handlers. Replaces the fixed 22:00 cron
 *               so a funnel like Corporate (21:30 Mon/Tue/Wed) runs on its own
 *               schedule.
 * Responsibility:
 *               - A 1-minute tick checks every active funnel: if its
 *                 generate_time matches the current HH:mm IST and today's weekday
 *                 is in its generate_days (blank = daily), run it.
 *               - Register approve/rework handlers.
 *               - A manual "run all now" endpoint.
 * Dependencies: node-cron, funnelPosterService, funnelsRepository, approvalService.
 *
 * Route: POST /api/v1/jobs/funnel-posters (run all active funnels immediately).
 */
import cron from 'node-cron';
import { DateTime } from 'luxon';
import * as poster from '../services/funnelPosterService.js';
import * as approvalService from '../services/approvalService.js';
import * as funnels from '../repositories/funnelsRepository.js';
import { requireAdminKey } from '../middleware/auth.js';
import { settings } from '../settings/index.js';
import { ZONE } from '../utils/time.js';

/**
 * Run funnels that are due. A funnel is due if today's weekday matches its
 * generate_days (blank = daily) and its generate_time falls within
 * [now - backMin, now + forwardMin]. The internal minute-cron uses (0, 2) for
 * an exact-minute match; the external /run-due trigger uses a small symmetric
 * window (~15) so a ~10-min-early ping still catches it and a late run doesn't
 * miss it — without running funnels scheduled far away.
 */
async function runDue(forwardMin, backMin, log) {
  const now = DateTime.now().setZone(ZONE);
  const dow = String(now.weekday); // 1 (Mon) .. 7 (Sun)
  const active = await funnels.listActive();
  for (const funnel of active) {
    const cfg = await funnels.resolve(funnel);
    const [h, m] = (cfg.generateTime || '22:00').split(':').map(Number);
    const target = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    const diffMin = target.diff(now, 'minutes').minutes;
    if (diffMin > forwardMin || diffMin < -backMin) continue;
    const days = (cfg.generateDays || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (days.length && !days.includes(dow)) continue;
    log.info({ funnel: funnel.name, at: cfg.generateTime }, 'funnel due; running');
    poster.runFunnel(funnel).catch((e) => log.error({ err: e.message, funnel: funnel.name }, 'funnel run failed'));
  }
}

export function register(ctx) {
  const { router, log } = ctx;

  approvalService.onKind(poster.KIND, {
    onApprove: (a) => poster.publish(a),
    onRework: (a, note) => poster.rework(a, note),
  });

  // Internal cron only when the host is always-on. In 'external' mode it is off
  // so the host can sleep; an external scheduler pings /jobs/run-due instead.
  if (settings.schedulerInternal) {
    let running = false;
    cron.schedule('* * * * *', async () => {
      if (running) return;
      running = true;
      try {
        await runDue(0, 2, log); // exact-minute match
      } catch (err) {
        log.error({ err: err.message }, 'funnel scheduler tick failed');
      } finally {
        running = false;
      }
    });
    log.info('funnel scheduler running (internal minute-cron)');
  } else {
    log.info("funnel scheduler in 'external' mode — trigger via POST /jobs/run-due");
  }

  // External trigger: run funnels due within the next `window` minutes (default 15).
  router.post('/jobs/run-due', requireAdminKey, async (req, res, next) => {
    try {
      const windowMin = Math.max(1, Number(req.query.window || 15));
      res.status(202).json({ accepted: true, window: windowMin });
      // Symmetric window: catches a funnel pinged ~10 min early and tolerates a
      // late run, without touching funnels scheduled far away.
      runDue(windowMin, windowMin, log).catch((e) => log.error({ err: e.message }, 'run-due failed'));
    } catch (err) {
      next(err);
    }
  });

  // Manual "run all active now" (ignores schedule).
  router.post('/jobs/funnel-posters', requireAdminKey, async (_req, res, next) => {
    try {
      res.status(202).json({ accepted: true });
      poster.runAllActive().catch((e) => log.error({ err: e.message }, 'manual funnel run failed'));
    } catch (err) {
      next(err);
    }
  });
}

export default { register };
