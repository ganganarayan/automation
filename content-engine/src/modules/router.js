/**
 * Module: daily post router (wake/sleep).
 *
 * Purpose:      The wake entry point for the daily router: decide tomorrow's
 *               lane per active funnel and line up what is needed (Lane 1
 *               ready video → Lane 2 AI video → Lane 3 image post, with
 *               their approval emails). Each tenant
 *               sets the time in Setup → Settings → Daily schedule (IST),
 *               default 16:00. GitHub Actions (.github/workflows/wake.yml)
 *               pings it; the app does the work under the heartbeat, then may
 *               sleep. On an always-on host (SCHEDULER_MODE=internal) an
 *               in-process 15-minute cron does the same.
 * Responsibility:
 *               - HTTP: POST /api/v1/jobs/router-check (admin-guarded, 202 +
 *                 async, idempotent per funnel + post date). A plain ping runs
 *                 only the tenants whose router_check_time is due (within the
 *                 last 6 hours, IST) and not yet run for that slot. ?all=1 runs every tenant; ?retry=1
 *                 re-decides days recorded as 'none' (every tenant); ?funnel=ID
 *                 limits the run to one funnel.
 *               - HTTP: POST /api/v1/jobs/nudge (admin-guarded, 202): the 10:00
 *                 nudge for the tenants whose nudge time is due (?all=1 = all).
 *               - HTTP (signed in): POST /api/v1/admin/router/rerun {funnelId}
 *, super admin only: re-run tomorrow's check for one funnel.
 *                 GET /api/v1/admin/credit-status: a live Lane 2 credit check
 *                 (the Keys and credit page reads it); POST
 *                 /api/v1/admin/credit/clear {key}, "I topped up".
 *               - Wire the lanes: approve / rework handlers for the image and
 *                 ready-video approval emails, the post check's "went live"
 *                 hook that marks the sheet row Posted, and the stage runner's
 *                 failure hook that drops a failed AI video to the image lane.
 * Dependencies: routerService, imageLaneService, readyLaneService,
 *               aiLaneService, creditService, stageRunnerService,
 *               approvalService, readyPostService, wakeScheduleService,
 *               accessService, funnelsRepository, settings, node-cron, auth middleware.
 */
import cron from 'node-cron';
import * as routerService from '../services/routerService.js';
import * as wakeSchedule from '../services/wakeScheduleService.js';
import { settings } from '../settings/index.js';
import * as imageLane from '../services/imageLaneService.js';
import * as readyLane from '../services/readyLaneService.js';
import * as aiLane from '../services/aiLaneService.js';
import * as credit from '../services/creditService.js';
import { creditView } from '../utils/routerSpec.js';
import * as stageRunner from '../services/stageRunnerService.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import { currentSession, keyOk } from '../services/accessService.js';
import * as approvalService from '../services/approvalService.js';
import * as readyPost from '../services/readyPostService.js';
import { requireAdminKey } from '../middleware/auth.js';

export function register(ctx) {
  const { router, log } = ctx;

  approvalService.onKind(imageLane.KIND, {
    onApprove: (a) => imageLane.approve(a),
    onRework: (a, note) => imageLane.rework(a, note),
  });
  approvalService.onKind(readyLane.KIND, {
    onApprove: (a) => readyLane.approve(a),
    onRework: (a) => readyLane.rework(a),
  });
  readyPost.onPosted((row, info) => imageLane.onPosted(row, info));
  stageRunner.onStageFailed((id, step, err) => aiLane.onStageFailed(id, step, err));
  const yes = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

  router.post('/jobs/router-check', requireAdminKey, async (req, res, next) => {
    try {
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

  router.post('/jobs/nudge', requireAdminKey, async (req, res, next) => {
    try {
      const tenantIds = yes(req.query.all) ? null : await wakeSchedule.dueTenants({ job: 'nudge' });
      res.status(202).json({ accepted: true, tenants: tenantIds || 'all' });
      if (tenantIds && !tenantIds.length) return log.info('nudge: no tenant due now');
      routerService.runNudge({ tenantIds, log }).catch((e) => log.error({ err: e.message }, 'nudge failed'));
    } catch (err) {
      next(err);
    }
  });

  // Super admin: re-run tomorrow's check for one funnel (Today page button).
  router.post('/admin/router/rerun', async (req, res) => {
    try {
      const session = await currentSession(req);
      if (!session || session.role !== 'super_admin') return res.status(403).json({ ok: false, error: 'super admin only' });
      const funnelId = Number((req.body || {}).funnelId || req.query.funnel);
      const funnel = funnelId ? await funnelsRepo.get(funnelId) : null;
      if (!funnel) return res.status(404).json({ ok: false, error: 'funnel not found' });
      const out = await routerService.rerun({ funnelId, log });
      log.info({ by: session.email, ...out }, 'router re-run requested');
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // A live Lane 2 credit check for the Keys and credit page.
  router.get('/admin/credit-status', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const tenantId = req.tenantId || 'default';
      const first = (await funnelsRepo.listByTenant(tenantId).catch(() => [])).find((f) => f.active);
      const funnelCfg = first ? await funnelsRepo.getConfig(first.id).catch(() => ({})) : {};
      const result = await credit.check({ tenantId, funnelCfg });
      const funnel = first ? first.name : '';
      res.set('Cache-Control', 'no-store').json({ ...result, ok: true, laneOk: result.ok, funnel, view: creditView({ ...result, funnel }) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // "I topped up": clear today's out-of-credit mark for one provider.
  router.post('/admin/credit/clear', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const key = String((req.body || {}).key || '');
      if (!['kling', 'runway', 'hailuo', 'voice', 'image', 'llm'].includes(key)) return res.status(400).json({ ok: false, error: 'unknown key' });
      res.json({ ok: true, cleared: await credit.clearExhausted(req.tenantId || 'default', key) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Always-on host: the same due test every 15 minutes (dueTenants runs each
  // slot once; router_days de-dupes per funnel + day as well).
  if (settings.schedulerInternal) {
    cron.schedule('*/15 * * * *', async () => {
      try {
        const tenantIds = await wakeSchedule.dueTenants();
        if (tenantIds.length) await routerService.runCheck({ tenantIds, log });
        const nudgeIds = await wakeSchedule.dueTenants({ job: 'nudge' });
        if (nudgeIds.length) await routerService.runNudge({ tenantIds: nudgeIds, log });
      } catch (err) {
        log.warn({ err: err.message }, 'scheduled router check failed');
      }
    });
  }

  log.info('daily router routes registered (POST /jobs/router-check, /jobs/nudge, /admin/router/rerun)');
}

export default { register };
