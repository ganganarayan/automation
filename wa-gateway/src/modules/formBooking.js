/**
 * Module: form booking.
 *
 * Purpose:      Turn a Google Form submission into a calendar-link WhatsApp
 *               message (queued through the throttle, instance gita).
 * Responsibility: parse flexible field casings -> compose -> enqueue.
 * Dependencies: sendService, tenantSettings.
 *
 * Route: POST /api/v1/webhook/gita-form-booking
 */
import { enqueueMessage } from '../services/sendService.js';
import * as tenantSettings from '../core/tenantSettings.js';

/** Read a field from a form payload regardless of casing/spacing. */
function field(body, ...names) {
  const map = {};
  for (const [k, v] of Object.entries(body || {})) map[k.toLowerCase().replace(/\s+/g, '')] = v;
  for (const n of names) {
    const key = n.toLowerCase().replace(/\s+/g, '');
    if (map[key] !== undefined) return map[key];
  }
  return undefined;
}

export function register(ctx) {
  const { router } = ctx;

  router.post('/webhook/gita-form-booking', async (req, res, next) => {
    try {
      const body = req.body || {};
      const name = field(body, 'name', 'fullname') || 'there';
      const number = field(body, 'mobile', 'phone', 'number', 'whatsapp');

      const resolved = await tenantSettings.forTenant(req.tenantId);
      const link = resolved.booking.calendarLink;
      const message =
        `Hi ${name}, Ganga Narayan Das here. Thank you for reaching out — ` +
        `you can book your session here: ${link}`;

      const row = await enqueueMessage({ tenantId: req.tenantId, instance: 'gita', number, message });
      if (!row) return res.status(200).json({ accepted: false, reason: 'invalid number' });
      res.status(202).json({ queued: true, id: row.id });
    } catch (err) {
      next(err);
    }
  });
}

export default { register };
