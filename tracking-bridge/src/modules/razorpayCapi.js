/**
 * Module: Razorpay -> Meta CAPI webhook.
 *
 * Purpose:      Verify the Razorpay signature against the raw body and, only for
 *               payment.captured, relay an enriched Purchase to Meta.
 * Responsibility: HTTP wiring + signature gate; logic in capiService.
 * Dependencies: signature util, capiService.
 *
 * Route: POST /api/v1/webhook/razorpay-capi
 *
 * On signature mismatch we respond 200 and drop silently (never reveal the
 * verification result to the caller).
 */
import { verifyRazorpaySignature } from '../utils/signature.js';
import * as capiService from '../services/capiService.js';
import * as tenantSettings from '../core/tenantSettings.js';

export function register(ctx) {
  const { router, providers } = ctx;

  router.post('/webhook/razorpay-capi', async (req, res) => {
    // Always ack; the caller must never learn whether verification passed.
    res.status(200).json({ ok: true });

    // Per-tenant module toggle + webhook secret.
    if (!(await tenantSettings.moduleEnabled(req.tenantId, 'capi'))) return;
    const resolved = await tenantSettings.forTenant(req.tenantId);

    const signature = req.headers['x-razorpay-signature'];
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyRazorpaySignature(raw, signature, resolved.razorpay.webhookSecret)) {
      req.log.warn('razorpay signature mismatch; dropped');
      return;
    }

    const payload = req.body || {};
    if (payload.event !== 'payment.captured') {
      req.log.info({ event: payload.event }, 'ignoring non-capture event');
      return;
    }

    capiService
      .process({ tenantId: req.tenantId, providers, payload })
      .catch((err) => req.log.error({ err: err.message }, 'capi processing failed'));
  });
}

export default { register };
