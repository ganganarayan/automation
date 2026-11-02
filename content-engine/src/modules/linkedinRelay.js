/**
 * Module: LinkedIn → WhatsApp relay.
 *
 * Purpose:      Poll Gmail for LinkedIn notification emails and relay them to the
 *               operator on WhatsApp. HTTP waker + (when the host stays awake)
 *               an internal cron; logic lives in linkedinRelayService.
 * Responsibility: HTTP + cron wiring only.
 * Dependencies: node-cron, linkedinRelayService, wakeScheduleService,
 *               tenantSettings, auth, settings.
 *
 * Route: POST /api/v1/jobs/poll-linkedin   (admin-guarded, 202 + async)
 *
 * Railway sleeps the idle service, so the primary trigger is the external cron
 * (.github/workflows/wake.yml) hitting the route at the relay times each tenant
 * sets in Setup → Settings → Daily schedule (IST). A plain ping relays for the
 * tenants whose slot is due and not yet run (wake_ran_relay), so the wide
 * catch-up window cannot relay the same mail twice; ?all=1 relays now for this
 * tenant whatever the time (the workflow's "run one job now" sends it). The
 * internal cron only runs when SCHEDULER_MODE=internal (an always-on host).
 */
import cron from 'node-cron';
import * as relay from '../services/linkedinRelayService.js';
import * as wakeSchedule from '../services/wakeScheduleService.js';
import { settings } from '../settings/index.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, log } = ctx;

  const pollFor = (tenantId) => relay.pollAndRelay({ tenantId })
    .then((r) => log.info({ tenantId, ...r }, 'poll-linkedin done'))
    .catch((e) => log.error({ tenantId, err: e.message }, 'poll-linkedin failed'));

  router.post('/jobs/poll-linkedin', async (req, res, next) => {
    try {
      // Admin-guarded like the other /jobs wakers; the external cron sends the key.
      if (req.headers['x-admin-key'] !== settings.auth.adminKey || !settings.auth.adminKey) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const all = ['1', 'true', 'yes'].includes(String(req.query.all || '').toLowerCase());
      const tenantIds = all ? null : await wakeSchedule.dueTenants({ job: 'relay' });
      res.status(202).json({ accepted: true, tenants: tenantIds || 'all' });
      if (tenantIds && !tenantIds.length) return log.info('poll-linkedin: no tenant due now');
      for (const id of tenantIds || [req.tenantId]) pollFor(id);
    } catch (err) {
      next(err);
    }
  });

  if (settings.schedulerInternal) {
    cron.schedule('*/10 * * * *', () => {
      relay.pollAndRelay({ tenantId: 'default' })
        .then((r) => { if (r.relayed) log.info(r, 'poll-linkedin (cron) relayed'); })
        .catch((e) => log.error({ err: e.message }, 'poll-linkedin cron failed'));
    }, { timezone: ZONE });
    log.info('linkedin relay cron scheduled (*/10 min)');
  }

  log.info('linkedin relay routes registered (POST /jobs/poll-linkedin)');
}

export default { register };
