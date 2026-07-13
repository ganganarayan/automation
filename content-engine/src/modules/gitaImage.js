/**
 * Module: Gita daily image poster.
 *
 * Purpose:      Schedule the 22:00 IST generation cron and wire the approve/
 *               rework handlers.
 * Responsibility: lifecycle + registration only; logic lives in gitaPosterService.
 * Dependencies: node-cron, gitaPosterService, approvalService.
 */
import cron from 'node-cron';
import * as poster from '../services/gitaPosterService.js';
import * as approvalService from '../services/approvalService.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { log } = ctx;

  approvalService.onKind(poster.KIND, {
    onApprove: (a) => poster.publish(a),
    onRework: (a, note) => poster.rework(a, note),
  });

  cron.schedule(
    '0 22 * * *',
    async () => {
      if (!(await tenantSettings.moduleEnabled('default', 'gitaImage'))) return;
      poster.runDaily({ tenantId: 'default' }).catch((e) => log.error({ err: e.message }, 'gita poster cron failed'));
    },
    { timezone: ZONE },
  );
  log.info('gita image poster scheduled 22:00 ' + ZONE);
}

export default { register };
