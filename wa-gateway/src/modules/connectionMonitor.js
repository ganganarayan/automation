/**
 * Module: connection monitor.
 *
 * Purpose:      Alert by email when Evolution reports an instance is not open.
 * Responsibility: parse the CONNECTION_UPDATE payload -> email alert if closed.
 * Dependencies: MailProvider, tenantSettings, eventLog.
 *
 * Route: POST /api/v1/webhook/evolution-connection
 */
import * as tenantSettings from '../core/tenantSettings.js';
import * as eventLog from '../repositories/eventLogRepository.js';
import { isoIst } from '../utils/time.js';
import { gate } from '../middleware/moduleGate.js';

export function register(ctx) {
  const { router, providers } = ctx;

  router.post('/webhook/evolution-connection', gate('connectionMonitor'), async (req, res, next) => {
    try {
      const body = req.body || {};
      const state = body?.data?.state ?? body?.state ?? 'unknown';
      const instance = body?.instance ?? body?.data?.instance ?? 'unknown';
      res.status(200).json({ accepted: true });

      if (state === 'open') return;

      const resolved = await tenantSettings.forTenant(req.tenantId);
      const to = resolved.alerts.email;
      await eventLog.append({
        tenantId: req.tenantId,
        eventType: 'wa.connection_alert',
        payload: { instance, state },
      });
      if (to) {
        await providers.mail.send({
          to,
          subject: `WhatsApp OFFLINE - ${instance}: ${state}`,
          text: `Evolution instance "${instance}" reported state "${state}" at ${isoIst()}.`,
        });
      }
    } catch (err) {
      next(err);
    }
  });
}

export default { register };
