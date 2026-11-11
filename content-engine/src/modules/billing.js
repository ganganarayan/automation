/**
 * Module: self-serve billing (public).
 *
 * Purpose:      The buy page, the calls its script makes, and Razorpay's webhook.
 * Responsibility: HTTP only; services/billingService does the work.
 * Dependencies: billingService, utils/buyPage, utils/billingSpec.
 *
 * Routes (mounted on the app, outside /api/v1, no sign-in):
 *   GET  /buy              the page (?plan=brand|agency&bill=mo|yr&units=n); currency from the IP
 *   POST /buy/start        { plan, bill, units, users, country, name, business, email, phone, gstin } -> Checkout details
 *   POST /buy/confirm      { paymentId, subscriptionId, signature } -> the new workspace's sign-in
 *   POST /buy/webhook      Razorpay webhook (X-Razorpay-Signature over the raw body)
 */
import * as billing from '../services/billingService.js';
import { buyPage } from '../utils/buyPage.js';
import { BUY_PATH } from '../utils/billingSpec.js';
import { currencyOf, billingCountry } from '../utils/geo.js';

/** A few purchase starts per address per hour: each one opens a Razorpay subscription. */
const starts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const hits = (starts.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  starts.set(ip, hits);
  if (starts.size > 5000) starts.clear();
  return hits.length > 10;
}

export function mount(app, { log, contactEmail = async () => '' }) {
  app.get(BUY_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const q = req.query || {};
      res.type('html').send(buyPage({
        plan: String(q.plan || ''), bill: String(q.bill || ''), cur: currencyOf(req), units: String(q.units || ''),
        ready: await billing.ready().catch(() => false), email: await contactEmail(),
      }));
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BUY_PATH}/start`, async (req, res) => {
    try {
      if (tooMany(req.ip || '')) return res.status(429).json({ ok: false, error: 'Too many tries. Wait a while and try again.' });
      // The IP decides the billing country when it is known (no GST dodging by
      // editing the form); the page's own value only when it is not.
      const body = { ...(req.body || {}) };
      body.country = billingCountry(req, body.country);
      const out = await billing.start(body);
      log.info({ sub: out.subscriptionId, plan: body.plan, country: body.country }, 'buy started');
      res.json({ ok: true, ...out });
    } catch (err) {
      log.warn({ err: err.message }, 'buy start refused');
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post(`${BUY_PATH}/confirm`, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await billing.confirm({ paymentId: String(b.paymentId || ''), subscriptionId: String(b.subscriptionId || ''), signature: String(b.signature || '') });
      log.info({ tenant: out.tenant, sub: b.subscriptionId }, 'buy confirmed');
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...out });
    } catch (err) {
      log.warn({ err: err.message, sub: req.body && req.body.subscriptionId }, 'buy confirm failed');
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post(`${BUY_PATH}/webhook`, async (req, res) => {
    try {
      const out = await billing.webhook(req.rawBody, String(req.get('x-razorpay-signature') || ''), req.body || {});
      if (!out.ok) {
        log.warn({ event: req.body && req.body.event }, 'billing webhook refused');
        return res.status(out.status || 400).json({ ok: false });
      }
      log.info({ event: req.body && req.body.event, ...out }, 'billing webhook');
      res.json({ ok: true });
    } catch (err) {
      // 500 makes Razorpay retry later.
      log.error({ err: err.message, event: req.body && req.body.event }, 'billing webhook failed');
      res.status(500).json({ ok: false });
    }
  });
}

export default { mount };
