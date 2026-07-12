/**
 * Module: VidaPulse daily image poster.
 *
 * Purpose:      Schedule the 22:00 IST generation cron and wire approve/rework.
 * Responsibility: lifecycle + registration; logic in vidapulsePosterService.
 * Dependencies: node-cron, vidapulsePosterService, approvalService.
 */
import cron from 'node-cron';
import * as poster from '../services/vidapulsePosterService.js';
import * as approvalService from '../services/approvalService.js';
import { ZONE } from '../utils/time.js';

export function register(ctx) {
  const { providers, log } = ctx;
  const deps = { providers };

  approvalService.onKind(poster.KIND, {
    onApprove: (a) => poster.publish(a, deps),
    onRework: (a, note) => poster.rework(a, note, deps),
  });

  cron.schedule(
    '0 22 * * *',
    () => poster.runDaily({ providers, tenantId: 'default' }).catch((e) => log.error({ err: e.message }, 'vidapulse poster cron failed')),
    { timezone: ZONE },
  );
  log.info('vidapulse image poster scheduled 22:00 ' + ZONE);
}

export default { register };
