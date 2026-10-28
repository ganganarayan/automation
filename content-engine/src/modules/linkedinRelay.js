/**
 * Module: LinkedIn → WhatsApp relay.
 *
 * Purpose:      Poll Gmail for LinkedIn notification emails and relay them to the
 *               operator on WhatsApp. HTTP waker + (when the host stays awake)
 *               an internal cron; logic lives in linkedinRelayService.
 * Responsibility: HTTP + cron wiring only.
 * Dependencies: node-cron, linkedinRelayService, tenantSettings, auth, settings.
 *
 * Route: POST /api/v1/jobs/poll-linkedin   (admin-guarded, 202 + async)
 *
 * Railway sleeps the idle service, so the primary trigger is the external cron
 * (.github/workflows/run-due.yml) hitting the route; the internal cron only runs
 * when SCHEDULER_MODE=internal (an always-on host).
 */
import cron from 'node-cron';
import * as relay from '../services/linkedinRelayService.js';
import { settings } from '../settings/index.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.post('/jobs/poll-linkedin', async (req, res, next) => {
    try {
      // Admin-guarded like the other /jobs wakers; the external cron sends the key.
      if (req.headers['x-admin-key'] !== settings.auth.adminKey || !settings.auth.adminKey) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      res.status(202).json({ accepted: true });
      relay.pollAndRelay({ tenantId: req.tenantId })
        .then((r) => log.info(r, 'poll-linkedin done'))
        .catch((e) => log.error({ err: e.message }, 'poll-linkedin failed'));
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
