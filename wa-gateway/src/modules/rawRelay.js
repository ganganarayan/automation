/**
 * Module: raw relays.
 *
 * Purpose:      Accept already-composed messages from the two CRM relays and
 *               enqueue them to the correct instance, honoring the line-break
 *               markers.
 * Responsibility: HTTP wiring; number cleaning + marker expansion + enqueue.
 * Dependencies: queueService, phone/text utils.
 *
 * Routes:
 *   POST /api/v1/webhook/gita-wa
 *   POST /api/v1/webhook/vidapulse-wa
 */
import * as queue from '../core/queueService.js';
import { cleanRelayNumber, hasMinDigits } from '../utils/phone.js';
import { applyLineBreakMarkers } from '../utils/text.js';
import { gate } from '../middleware/moduleGate.js';

export function register(ctx) {
  const { router } = ctx;
  router.post('/webhook/gita-wa', gate('rawRelay'), handler('gita'));
  router.post('/webhook/vidapulse-wa', gate('rawRelay'), handler('vidapulse'));
}

function handler(instance) {
  return async (req, res, next) => {
    try {
      const body = req.body || {};
      const number = cleanRelayNumber(body.number ?? body.phone);
      const text = applyLineBreakMarkers(body.text ?? body.message ?? '');

      if (!hasMinDigits(number, 12) || !text.trim()) {
        return res.status(200).json({ accepted: false, reason: 'invalid number or empty text' });
      }
      const row = await queue.enqueue({ tenantId: req.tenantId, instance, number, message: text });
      res.status(202).json({ queued: true, id: row.id, instance });
    } catch (err) {
      next(err);
    }
  };
}

export default { register };
