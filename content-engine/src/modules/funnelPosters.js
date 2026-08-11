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
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, log } = ctx;

  approvalService.onKind(poster.KIND, {
    onApprove: (a) => poster.publish(a),
    onRework: (a, note) => poster.rework(a, note),
  });

  let running = false;
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const now = DateTime.now().setZone(ZONE);
      const hhmm = now.toFormat('HH:mm');
      const dow = String(now.weekday); // 1 (Mon) .. 7 (Sun)
      const active = await funnels.listActive();
      for (const funnel of active) {
        const cfg = await funnels.resolve(funnel);
        if (cfg.generateTime !== hhmm) continue;
        const days = (cfg.generateDays || '').split(',').map((d) => d.trim()).filter(Boolean);
        if (days.length && !days.includes(dow)) continue;
        log.info({ funnel: funnel.name, at: hhmm }, 'funnel due; running');
        poster.runFunnel(funnel).catch((e) => log.error({ err: e.message, funnel: funnel.name }, 'funnel run failed'));
      }
    } catch (err) {
      log.error({ err: err.message }, 'funnel scheduler tick failed');
    } finally {
      running = false;
    }
  });

  router.post('/jobs/funnel-posters', requireAdminKey, async (_req, res, next) => {
    try {
      res.status(202).json({ accepted: true });
      poster.runAllActive().catch((e) => log.error({ err: e.message }, 'manual funnel run failed'));
    } catch (err) {
      next(err);
    }
  });

  log.info('funnel scheduler running (per-funnel time + days)');
}

export default { register };
