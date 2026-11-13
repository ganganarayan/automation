/**
 * Module: Plan page with one-click cancel.
 *
 * Purpose:      A workspace admin sees their plan and its end date and cancels
 *               with one click: the renewal stops, the workspace keeps working
 *               until its expiry, and they are sent to the owner's exit
 *               assessment (tagged with their workspace id). Keep my plan undoes
 *               it. The owner (super admin) sets the exit assessment link here.
 * Responsibility: HTTP + HTML.
 * Dependencies: tenantRepository, tenantConfigRepository, accessService,
 *               utils/cancelSpec, utils/planPage, utils/adminNav, utils/time.
 *
 * Routes: GET  /api/v1/admin/plan              the page
 *         POST /api/v1/admin/plan/cancel       form post, then the exit assessment
 *         POST /api/v1/admin/plan/resume       form post, back to the page
 *         POST /api/v1/admin/plan/solo         form post: move to Solo from the next renewal
 *         POST /api/v1/admin/plan/exit-link    super admin: { url }
 *         POST /api/v1/admin/plan/test/:step   super admin, test payments: subscribe | upgrade | upgrade-paid | downgrade | cancel | renew | renew-paid
 */
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { keyOk, currentSession } from '../services/accessService.js';
import { cancelProblem, exitLink, validExitUrl, EXIT_KEY, OWNER_TENANT } from '../utils/cancelSpec.js';
import { planBody, soloOffer, PLAN_PATH } from '../utils/planPage.js';
import { navHtml, NAV_CSS, NAV_SHELL_CSS } from '../utils/adminNav.js';
import { formatIst } from '../utils/time.js';
import * as billing from '../services/billingService.js';
import * as billingTest from '../services/billingTestService.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (v) => (v ? formatIst(v, { withTime: false }) : '');

async function exitBase() {
  return (await tenantConfig.get(OWNER_TENANT, EXIT_KEY).catch(() => null)) || '';
}

/** Who is asking, about which workspace. */
async function who(req) {
  const session = await currentSession(req);
  const superAdmin = !!(session && session.role === 'super_admin');
  const tenant = await tenantRepo.findById(String(req.tenantId || OWNER_TENANT));
  return { session, superAdmin, tenant, role: req.workspaceRole || 'admin' };
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/plan', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.set('Cache-Control', 'no-store');
      const w = await who(req);
      const base = w.superAdmin ? await exitBase() : '';
      let pay = null;
      if (w.superAdmin) {
        const k = await billing.keys().catch(() => ({ keyId: '', keySecret: '', webhookSecret: '' }));
        pay = { keyId: k.keyId, secretSet: !!k.keySecret, webhookSet: !!k.webhookSecret, tests: await billingTest.list().catch(() => []) };
      }
      const origin = `${req.protocol}://${req.get('host')}`;
      res.type('html').send(shell('Plan', planBody({ ...w, base, flash: String(req.query.done || ''), day, pay, origin }), w.session));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/plan/cancel', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send('<p>Sign in first.</p>');
      const w = await who(req);
      const why = cancelProblem(w);
      if (why) return res.status(403).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">${esc(why)}</p><p><a class="act" href="${PLAN_PATH}">Back</a></p>`, w.session));
      if (w.tenant.billing_sub_id && !w.tenant.cancelled_at) {
        // Paid online: stop the Razorpay renewal first, so "not charged again" is true.
        try {
          await billing.stopRenewal(w.tenant);
        } catch (err) {
          log.error({ tenant: w.tenant.id, err: err.message }, 'razorpay cancel failed');
          return res.status(502).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">🟡 The renewal could not be stopped just now (${esc(err.message)}). Nothing was changed. Try again in a minute, or write to us.</p><p><a class="act" href="${PLAN_PATH}">Back</a></p>`, w.session));
        }
      }
      if (!w.tenant.cancelled_at) await tenantRepo.setCancelled(w.tenant.id, new Date());
      log.info({ tenant: w.tenant.id, by: w.session && w.session.email }, 'plan cancelled');
      const link = exitLink(await exitBase(), { tenantId: w.tenant.id, plan: w.tenant.plan || '' });
      return res.redirect(303, link || `${PLAN_PATH}?done=cancelled`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/plan/resume', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send('<p>Sign in first.</p>');
      const w = await who(req);
      const why = cancelProblem(w);
      if (why) return res.status(403).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">${esc(why)}</p><p><a class="act" href="${PLAN_PATH}">Back</a></p>`, w.session));
      if (w.tenant.billing_sub_id) return res.status(409).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">The online renewal is already stopped. Buy the plan again from <a href="/#pricing">pricing</a> when the period ends.</p><p><a class="act" href="${PLAN_PATH}">Back</a></p>`, w.session));
      await tenantRepo.setCancelled(w.tenant.id, null);
      log.info({ tenant: w.tenant.id, by: w.session && w.session.email }, 'plan kept');
      return res.redirect(303, `${PLAN_PATH}?done=kept`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/plan/solo', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send('<p>Sign in first.</p>');
      const w = await who(req);
      const why = cancelProblem(w);
      const back = `<p><a class="act" href="${PLAN_PATH}">Back</a></p>`;
      if (why) return res.status(403).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">${esc(why)}</p>${back}`, w.session));
      if (!soloOffer(w.tenant)) return res.status(409).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">Solo is not open to this workspace.</p>${back}`, w.session));
      if (!w.tenant.billing_sub_id) return res.status(409).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">Your plan was set up by us: write to us and we move you to Solo.</p>${back}`, w.session));
      try {
        await billing.switchToSolo(w.tenant);
      } catch (err) {
        log.warn({ tenant: w.tenant.id, err: err.message }, 'solo switch failed');
        return res.status(502).type('html').send(shell('Plan', `<h1>Plan</h1><p class="hint">🟡 ${esc(err.message)}</p>${back}`, w.session));
      }
      log.info({ tenant: w.tenant.id, by: w.session && w.session.email }, 'moved to solo at next renewal');
      return res.redirect(303, `${PLAN_PATH}?done=solo`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/plan/billing-keys', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'Sign in first.' });
      const session = await currentSession(req);
      if (!session || session.role !== 'super_admin') return res.status(403).json({ ok: false, error: 'Only the owner sets this.' });
      const b = req.body || {};
      const out = await billing.saveKeys({ keyId: String(b.keyId || ''), keySecret: String(b.keySecret || ''), webhookSecret: String(b.webhookSecret || '') });
      log.info({ by: session.email, live: out.live }, 'razorpay keys saved');
      return res.json({ ok: true, ...out });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Owner only: test payments on every plan with the live keys (Payments).
  const TEST_STEPS = {
    subscribe: (b) => billingTest.startSubscribe({ plan: String(b.plan || ''), name: String(b.name || ''), email: String(b.email || ''), phone: String(b.phone || '') }),
    upgrade: (b) => billingTest.startUpgrade({ tenantId: String(b.tenantId || ''), plan: String(b.plan || '') }),
    'upgrade-paid': (b) => billingTest.confirmUpgrade({ orderId: String(b.orderId || ''), paymentId: String(b.paymentId || ''), signature: String(b.signature || '') }),
    downgrade: (b) => billingTest.downgrade({ tenantId: String(b.tenantId || ''), plan: String(b.plan || '') }),
    cancel: (b) => billingTest.cancel({ tenantId: String(b.tenantId || '') }),
    renew: (b) => billingTest.startRenew({ tenantId: String(b.tenantId || '') }),
    'renew-paid': (b) => billingTest.confirmRenew({ paymentId: String(b.paymentId || ''), subscriptionId: String(b.subscriptionId || ''), signature: String(b.signature || '') }),
  };
  router.post('/admin/plan/test/:step', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'Sign in first.' });
      const session = await currentSession(req);
      if (!session || session.role !== 'super_admin') return res.status(403).json({ ok: false, error: 'Only the owner runs tests.' });
      const step = TEST_STEPS[req.params.step];
      if (!step) return res.status(404).json({ ok: false, error: 'No such step' });
      const out = await step(req.body || {});
      log.info({ by: session.email, step: req.params.step, tenant: out.tenant || req.body?.tenantId || '' }, 'billing test step');
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ...out });
    } catch (err) {
      log.warn({ step: req.params.step, err: err.message }, 'billing test step failed');
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/plan/exit-link', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'Sign in first.' });
      const session = await currentSession(req);
      if (!session || session.role !== 'super_admin') return res.status(403).json({ ok: false, error: 'Only the owner sets this.' });
      const url = String(req.body?.url || '').trim();
      if (!validExitUrl(url)) return res.json({ ok: false, error: 'Paste a full link starting with https://' });
      if (url) await tenantConfig.set(OWNER_TENANT, EXIT_KEY, url);
      else await tenantConfig.del(OWNER_TENANT, EXIT_KEY);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });
}

function shell(title, inner, session) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}, automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:760px;margin:1.4rem auto;padding:0 1rem}
${NAV_SHELL_CSS}
${NAV_CSS}
 .top{margin-bottom:1rem}h1{font-size:1.3rem;margin:0}.sub{color:#8a8aa2;font-size:.82rem;margin-top:.2rem}
 h2{font-size:.95rem;color:#c7c7d9;margin:1.6rem 0 .5rem}
 .hint{color:#9a9ab0;font-size:.88rem}.ok{color:#e8e8ef}
 .card{background:#13131f;border:1px solid #24243a;border-radius:10px;padding:.4rem 1rem}
 .row{display:flex;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid #24243a}.row:last-child{border-bottom:0}.row span{color:#9a9ab0}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.5rem .95rem;cursor:pointer;font-size:.88rem;text-decoration:none;display:inline-block}
 .act.primary{background:#2d6cdf}.act.danger{background:#7a1f2b}
 .inl{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.6rem;margin:.8rem 0}
 .grid2 label{display:grid;gap:.25rem;font-size:.84rem;color:#9a9ab0}
 .grid2 input{background:#13131f;border:1px solid #2a2a44;color:#e8e8ef;border-radius:8px;padding:.5rem .6rem}
 input[type=url]{flex:1;min-width:260px;background:#13131f;border:1px solid #2a2a44;color:#e8e8ef;border-radius:8px;padding:.5rem .6rem}
 a{color:#7aa2ff}
</style>
<div class="layout">
  <aside>${navHtml({ current: 'plan', session })}</aside>
  <main><div class="wrap">${inner}</div></main>
</div>`;
}

export default { register };
