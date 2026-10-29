/**
 * Module: tenant-scoped configuration UI (with Users management).
 *
 * Purpose:      Browser control panel to configure each app per tenant and to
 *               manage users, roles, and plans. Settings write to the shared
 *               tenant_config table (every service's resolver reads it).
 * Responsibility: HTTP wiring + HTML rendering; logic in configService/usersRepository.
 * Dependencies: configService, configManifest, tenantRepository, usersRepository,
 *               tenantConfigRepository, accessService.
 *
 * Users model (self-signup; auth/login added later):
 *   - Accounts are created on sign-up. The super admin (ganganarayan.rns@gmail.com)
 *     is seeded and protected.
 *   - The super admin changes each user's role (user/admin/super_admin) and plan
 *     end date (a date, or "forever") with inline auto-save — no save button.
 *   - Each user has billing history and last login. Users manage their own
 *     password in their own login (not here).
 *   - Interim page access is a UI-settable key (accessService); real login later.
 *
 * Routes (guarded by the access key when set):
 *   GET  /api/v1/admin/settings              the control panel
 *   POST /api/v1/admin/settings/save         apply one app's config form
 *   POST /api/v1/admin/tenants               create a tenant
 *   POST /api/v1/admin/users/role            change a user's role (JSON, auto-save)
 *   POST /api/v1/admin/users/plan            change a user's plan end (JSON, auto-save)
 *   GET  /api/v1/admin/users/billing         a user's billing history (JSON)
 *   POST /api/v1/admin/access/key            set/clear the access key
 */
import { CONFIG_MANIFEST, APPS, fieldByKey } from '../services/configManifest.js';
import { navHtml, NAV_CSS } from '../utils/adminNav.js';
import { FLOW_MANIFEST, hasFlow } from '../services/flowManifest.js';
import { WIZARD_STEPS, completeness } from '../services/videoWizardManifest.js';
import * as imageGateService from '../services/imageGateService.js';
import * as configService from '../services/configService.js';
import * as users from '../repositories/usersRepository.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import * as tenantConfigRepo from '../repositories/tenantConfigRepository.js';
import { listOpenAiModels, listGeminiModels } from '../providers/modelsProvider.js';
import { buildCatalog } from '../utils/modelCatalog.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { buildProviders } from '../services/providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { keyOk, requiredKey, verifyKey, setAccessCookie, clearAccessCookie, ACCESS_KEY_STORE } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  // Sign in: exchange the key for an httpOnly cookie, then land on a clean URL.
  router.post('/admin/login', async (req, res, next) => {
    try {
      const nextTarget = req.body?.next === 'dashboard' ? '/api/v1/dashboard' : '/api/v1/admin/settings';
      if (await verifyKey(req.body?.key)) {
        await setAccessCookie(res);
        return res.redirect(nextTarget);
      }
      return res.status(401).type('html').send(gatePage(nextTarget, 'Wrong key'));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/logout', (req, res) => {
    clearAccessCookie(res);
    res.redirect('/api/v1/admin/settings');
  });

  router.get('/admin/settings', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send(gatePage('/api/v1/admin/settings'));
      // Migrate any ?key= visit onto the cookie and strip it from the URL.
      if (req.query.key) {
        await setAccessCookie(res);
        const q = new URLSearchParams();
        if (req.query.tenant) q.set('tenant', String(req.query.tenant));
        return res.redirect(`/api/v1/admin/settings${q.toString() ? `?${q}` : ''}`);
      }
      const tenantId = (req.query.tenant || 'default').toString();
      const [configMap, userList, funnelList, hasKey] = await Promise.all([
        configService.load(tenantId).catch(() => ({})),
        users.list().catch(() => []),
        funnels.listByTenant(tenantId).catch(() => []),
        requiredKey().then((k) => !!k),
      ]);
      const funnelConfigs = {};
      for (const f of funnelList) funnelConfigs[f.id] = await funnels.getConfig(f.id).catch(() => ({}));
      res.type('html').send(
        page({ tenantId, configMap, userList, funnelList, funnelConfigs, hasKey, key: '', saved: req.query.saved }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/settings/save', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const tenantId = (body.tenant || 'default').toString();
      const submitted = { settings: body.set || {}, modules: body.mod || {} };
      const result = await configService.save(tenantId, body.app, submitted);
      const q = new URLSearchParams({ tenant: tenantId });
      if (result.errors.length) q.set('error', result.errors.join('; '));
      else q.set('saved', body.app);
      res.redirect(`/api/v1/admin/settings?${q.toString()}#${body.app}`);
    } catch (err) {
      next(err);
    }
  });

  // --- Funnels (multi-account content scope) ---
  // Absolute redirect target (relative paths resolve against the POST route,
  // which produced a /admin/funnels/settings 404).
  const backToFunnels = (body) =>
    `/api/v1/admin/settings?${new URLSearchParams({ tenant: body.tenant || 'default' })}#funnels`;

  router.post('/admin/funnels', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const name = (body.name || '').toString().trim();
      if (name) await funnels.create({ tenantId: body.tenant || 'default', name });
      res.redirect(backToFunnels(body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/config', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const id = Number(body.funnel_id);
      const funnel = await funnels.get(id);
      if (funnel) {
        const set = body.set || {};
        for (const field of funnels.FUNNEL_FIELDS) {
          if (!(field.key in set)) continue;
          const val = String(set[field.key] ?? '');
          if (field.type === 'secret') {
            if (val.trim() !== '') await funnels.setConfig(id, field.key, val);
          } else if (val.trim() === '') {
            await funnels.delConfig(id, field.key);
          } else {
            await funnels.setConfig(id, field.key, val.trim());
          }
        }
      }
      res.redirect(backToFunnels(body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/active', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      await funnels.setActive(Number(body.funnel_id), body.active === 'true');
      res.redirect(backToFunnels(body));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/remove', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      await funnels.remove(Number(body.funnel_id));
      res.redirect(backToFunnels(body));
    } catch (err) {
      next(err);
    }
  });

  // Pull the connected social accounts from Post for Me so the funnel's account
  // IDs can be picked with checkboxes instead of hand-typed JSON. Uses the key
  // typed in the box if present, else the funnel's saved key. Returns JSON.
  // Ask the provider which models the saved key can actually call, cache the
  // short list, and let the settings dropdowns offer it (no hand-typed models).
  router.post('/admin/settings/models/refresh', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const provider = String(req.body?.provider || '').toLowerCase();
      const tenantId = req.tenantId;
      const t = await tenantSettings.forTenant(tenantId);
      let cat = {};
      try { cat = JSON.parse((await tenantConfigRepo.get(tenantId, 'models_catalog')) || '{}') || {}; } catch { cat = {}; }

      if (provider === 'openai') {
        const fresh = buildCatalog({ openaiIds: await listOpenAiModels(t.openai.apiKey, log) });
        cat.openai_image = fresh.openai_image; cat.openai_text = fresh.openai_text;
      } else if (provider === 'gemini') {
        const fresh = buildCatalog({ geminiModels: await listGeminiModels(t.gemini.apiKey, log) });
        cat.gemini_image = fresh.gemini_image; cat.gemini_text = fresh.gemini_text;
      } else {
        return res.status(400).json({ ok: false, error: 'unknown provider' });
      }
      cat.refreshedAt = new Date().toISOString();
      await tenantConfigRepo.set(tenantId, 'models_catalog', JSON.stringify(cat));
      tenantSettings.invalidate(tenantId);
      res.json({ ok: true, image: (cat[provider + '_image'] || []).length, text: (cat[provider + '_text'] || []).length });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/funnels/fetch-accounts', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      let apiKey = (req.body?.api_key || '').toString().trim();
      if (!apiKey) {
        // The Post for Me key is central now (Settings → API Keys), not per funnel.
        const t = await tenantSettings.forTenant(req.tenantId);
        apiKey = t.postformeKey || '';
      }
      if (!apiKey) return res.json({ ok: false, error: 'No Post for Me API key — set it once under Settings → API Keys, then come back and Fetch.' });
      const provider = createPostForMeProvider({ apiKey }, log);
      const data = await provider.listAccounts();
      return res.json({ ok: true, accounts: normalizeAccounts(data) });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  // --- Video setup wizard (step-by-step; replaces the flat funnel form) ---
  router.get('/admin/funnels/:id/setup', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send(gatePage('/api/v1/admin/settings'));
      const id = Number(req.params.id);
      const funnel = await funnels.get(id);
      if (!funnel) return res.redirect('/api/v1/admin/settings#funnels');
      const cfg = await funnels.getConfig(id).catch(() => ({}));
      let stepIndex = Number(req.query.step);
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= WIZARD_STEPS.length) stepIndex = 0;
      res.type('html').send(wizardPage({ funnel, cfg, stepIndex, complete: completeness(cfg) }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/funnels/:id/setup/save', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const funnel = await funnels.get(id);
      if (!funnel) return res.status(404).json({ ok: false, error: 'funnel not found' });
      const stepIndex = Number(req.body?.step);
      const step = WIZARD_STEPS[stepIndex];
      if (!step) return res.status(400).json({ ok: false, error: 'bad step' });
      const set = req.body?.set || {};
      for (const field of step.fields) {
        if (!(field.key in set)) continue;
        const val = String(set[field.key] ?? '');
        if (field.type === 'secret') {
          if (val.trim() !== '') await funnels.setConfig(id, field.key, val);
        } else if (val.trim() === '') {
          await funnels.delConfig(id, field.key);
        } else {
          await funnels.setConfig(id, field.key, val.trim());
        }
      }
      const cfg = await funnels.getConfig(id).catch(() => ({}));
      res.json({ ok: true, complete: completeness(cfg) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Generate a small test batch of stills for a funnel and email the review.
  router.post('/admin/funnels/:id/image-gate/test', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      try {
        await imageGateService.precheck({ tenantId: req.tenantId, funnelId: id });
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
      const topic = (req.body?.topic || '').toString();
      const count = Number(req.body?.count) || 2;
      imageGateService
        .generateForFunnel({ tenantId: req.tenantId, funnelId: id, topic, count })
        .catch((e) => log.error({ err: e.message, funnel: id }, 'image gate test failed'));
      res.json({ ok: true, message: 'Generating — you’ll get a review email shortly.' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // --- Users: inline auto-save (JSON) ---
  router.post('/admin/users/role', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      await users.setRole(req.body.email, req.body.role);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/admin/users/plan', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const forever = req.body.forever === true || req.body.forever === 'true';
      const endsAt = forever || !req.body.date ? null : new Date(req.body.date);
      await users.setPlanEnd(req.body.email, endsAt);
      res.json({ ok: true, endsAt });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Send a test email using the tenant's saved SMTP settings.
  router.post('/admin/test-email', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const providers = await buildProviders(req.tenantId);
      const smtp = providers.resolved.smtp || {};
      const to = (req.body?.to || smtp.from || smtp.user || '').trim();
      if (!smtp.host || !smtp.user) return res.json({ ok: false, error: 'SMTP not configured — set host/user and Save first' });
      if (!to) return res.json({ ok: false, error: 'no recipient (set a From/user address)' });
      const result = await providers.mail.send({
        to,
        subject: 'Test email — automation content-engine',
        text: 'This is a test from your content-engine SMTP settings. If you received this, approval and status emails will work.',
      });
      res.json({ ok: !!result.ok, to, error: result.ok ? null : 'send failed' });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  router.get('/admin/users/billing', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      res.json({ rows: await users.billingFor(req.query.email) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/access/key', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const newKey = (req.body.new_key || '').toString();
      if (newKey.trim() === '') {
        await tenantConfig.del(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
        clearAccessCookie(res);
      } else {
        await tenantConfig.set(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key, newKey);
        await setAccessCookie(res); // refresh cookie to the new key (never in the URL)
      }
      res.redirect(`/api/v1/admin/settings?${new URLSearchParams({ tenant: req.body.tenant || 'default' })}#users`);
    } catch (err) {
      next(err);
    }
  });

  log.info('config UI routes registered');
}

// ---- rendering -------------------------------------------------------------

function page({ tenantId, configMap, userList, funnelList, funnelConfigs, hasKey, key, saved }) {
  const menu = navHtml({ key, tabs: true });

  const appSections = APPS
    .map((a) => (hasFlow(a) ? flowSection(a, tenantId, configMap, key) : appSection(a, tenantId, configMap, key)))
    .join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — control panel</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .layout{display:flex;min-height:100vh}
 aside{width:220px;flex:0 0 220px;background:#12121b;border-right:1px solid #24243a;padding:1rem .6rem;position:sticky;top:0;height:100vh;overflow:auto}
 aside .brand{font-weight:700;padding:.4rem .6rem 1rem;font-size:1.05rem}
 .nav{display:block;width:100%;text-align:left;background:none;border:0;color:#c7c7d9;padding:.6rem .7rem;border-radius:8px;font-size:.92rem;cursor:pointer;margin-bottom:.15rem}
 .nav:hover{background:#1c1c2a}.nav.active{background:#2a2a44;color:#fff}
${NAV_CSS}
 aside .dash{display:block;margin-top:1rem;color:#7aa2ff;text-decoration:none;font-size:.85rem;padding:.4rem .7rem;border-top:1px solid #24243a}
 main{flex:1;padding:1.3rem;max-width:960px}
 header.top{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}
 select,input,textarea{background:#0b0b12;color:#fff;border:1px solid #333;border-radius:8px;padding:.5rem}
 textarea{width:100%;min-height:4.5rem;font-family:ui-monospace,monospace;font-size:.82rem}
 .panel{display:none}.panel.active{display:block}
 section.card{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:1.2rem;margin-bottom:1.3rem}
 h2{margin:0 0 .2rem}.blurb{color:#8a8aa2;font-size:.85rem;margin:0 0 1rem}
 fieldset{border:1px solid #24243a;border-radius:10px;margin:0 0 1rem;padding:.8rem 1rem}
 legend{color:#9a9ab0;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:0 .4rem}
 label{display:block;margin:.6rem 0 .2rem;font-size:.85rem;color:#c7c7d9}
 .field input,.field select{width:100%}
 .mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:.6rem}
 .mod{display:flex;justify-content:space-between;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem}
 .mod span{font-size:.85rem}
 .save{margin-top:.5rem;background:#0a7d32;color:#fff;border:0;border-radius:8px;padding:.6rem 1.3rem;font-size:.95rem;cursor:pointer}
 button.act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.45rem .9rem;cursor:pointer}
 table{width:100%;border-collapse:collapse;font-size:.88rem}
 th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #24243a;vertical-align:middle}
 .flash{background:#123b1f;border:1px solid #1f6b38;color:#8ff0b0;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.9rem}
 .err{background:#3b1212;border:1px solid #6b1f1f;color:#ff9a9a}
 .warn{background:#3a2f12;border:1px solid #7a5a1f;color:#f0d68f;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem}
 .pill{font-size:.72rem;padding:.1rem .5rem;border-radius:999px;border:1px solid #24243a;color:#c7c7d9}
 .hint{color:#6f6f88;font-size:.78rem;margin:.2rem 0 0}
 .row{display:flex;gap:.5rem;align-items:end;flex-wrap:wrap}
 .saveflag{font-size:.72rem;color:#5bd08a;margin-left:.4rem;opacity:0;transition:opacity .2s}
 .saveflag.show{opacity:1}
 .planwrap{display:flex;gap:.5rem;align-items:center}
 .billing{background:#0d0d16;border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem;margin:.3rem 0}
 a{color:#7aa2ff}
 a.act{display:inline-flex;align-items:center;text-decoration:none;background:#2a2a44;color:#fff;border-radius:8px;padding:.45rem .9rem}
 .act.primary{background:#2d6cdf;color:#fff}
 .act.danger{background:#5a1d1d;color:#fff}
 .funnellist{display:flex;flex-direction:column;gap:.6rem}
 .funnelrow{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;background:#15151f;border:1px solid #24243a;border-radius:10px;padding:.8rem 1rem}
 .funnelrow-name{font-weight:600}
 .funnelrow-meta{font-size:.8rem;color:#8a8aa2;margin-top:.15rem}
 /* flowchart view */
 .flow{margin:.5rem 0}
 .flowphase{margin:0}
 .flowphase-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#8a8aa2;margin:.2rem 0 .5rem}
 .flowrow{display:block}
 .flowrow.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem}
 .flowbox{background:#15151f;border:1px solid #2a2a44;border-radius:10px;padding:.8rem 1rem;margin:0 0 .8rem}
 .flowrow.cols .flowbox{margin:0}
 .flowbox-head{display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap}
 .flowbox-head h4{margin:0;font-size:.98rem}
 .flowdesc{color:#9a9ab0;font-size:.82rem;margin:.25rem 0 .5rem}
 .flowinfo{color:#6f6f88;font-size:.78rem;margin:.4rem 0 0;border-top:1px dashed #24243a;padding-top:.4rem}
 .flowtoggle{display:flex;align-items:center;gap:.4rem}
 .flowtoggle span{font-size:.72rem;color:#8a8aa2}
 .flowtoggle select{padding:.3rem .5rem}
 .flowarrow{text-align:center;color:#4a4a66;font-size:1rem;margin:-.2rem 0 .5rem}
 /* selectable schedule + account picker */
 input.pick,select.pick{width:auto;min-width:140px}
 input[type=time].pick{min-width:120px}
 .daychips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}
 .daychip{display:inline-flex;align-items:center;gap:.3rem;background:#15151f;border:1px solid #2a2a44;border-radius:999px;padding:.3rem .7rem;font-size:.85rem;cursor:pointer;margin:0}
 .daychip input{margin:0}
 .acctlist{display:flex;flex-direction:column;gap:.3rem;margin:.4rem 0;max-height:260px;overflow:auto}
 .acct{display:flex;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.4rem .7rem;font-size:.85rem;cursor:pointer;margin:0}
 .acct b{color:#c7c7d9;text-transform:capitalize}
</style>
<div class="layout">
  <aside>
    ${menu}
  </aside>
  <main>
    ${saved ? `<div class="flash">Saved <b>${esc(saved)}</b>.</div>` : ''}
    <div id="flash-error" class="flash err" style="display:none"></div>

    ${usersPanel({ userList, hasKey, tenantId, key })}
    ${funnelsPanel({ funnelList, funnelConfigs, tenantId, key })}
    ${appSections}

    <p class="hint">Blank config fields fall back to a platform default where one exists. Secrets are never shown — leave blank to keep the current value. Changes apply within ~1 minute.</p>
  </main>
</div>
<script>
  const KEY = ${JSON.stringify(key || '')};
  function show(id){
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+id));
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.target===id));
    if(history.replaceState) history.replaceState(null,'',location.pathname+location.search+'#'+id);
  }
  function flag(i){ const f=document.getElementById('flag-'+i); if(!f) return; f.classList.add('show'); setTimeout(()=>f.classList.remove('show'),1200); }
  async function post(path, body){
    const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':KEY},body:JSON.stringify(body)});
    return r.ok ? r.json() : Promise.reject(await r.json().catch(()=>({error:'failed'})));
  }
  async function saveRole(i, email, sel){
    try{ await post('users/role',{email,role:sel.value}); flag(i); }
    catch(e){ alert('Could not change role: '+(e.error||'')); }
  }
  async function savePlan(i, email){
    const forever=document.getElementById('fv-'+i).checked;
    const dt=document.getElementById('dt-'+i);
    dt.disabled=forever;
    try{ await post('users/plan',{email,forever,date:dt.value}); flag(i); }
    catch(e){ alert('Could not change plan: '+(e.error||'')); }
  }
  async function toggleBilling(i, email){
    const box=document.getElementById('bill-'+i);
    if(box.style.display==='table-row'){ box.style.display='none'; return; }
    box.style.display='table-row';
    const cell=document.getElementById('billbody-'+i);
    cell.textContent='Loading…';
    try{
      const r=await fetch('users/billing?email='+encodeURIComponent(email),{headers:{'X-Admin-Key':KEY}});
      const j=await r.json();
      cell.innerHTML = (j.rows&&j.rows.length)
        ? '<div class="billing">'+j.rows.map(x=>esc2(x.occurred_at)+' — '+esc2(x.description||'')+' — ₹'+esc2(x.amount_inr||'0')+' ('+esc2(x.status||'')+')').join('<br>')+'</div>'
        : '<div class="billing hint">No billing history yet.</div>';
    }catch(e){ cell.textContent='Failed to load billing.'; }
  }
  function esc2(s){ return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  async function refreshModels(provider){
    const st=document.getElementById('mdl-'+provider);
    if(st){ st.textContent='Loading…'; st.style.color=''; }
    try{
      const r=await fetch('/api/v1/admin/settings/models/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider})});
      const j=await r.json();
      if(j.ok){ if(st){ st.textContent='✓ '+(j.image+j.text)+' models'; st.style.color='#5bd08a'; } setTimeout(function(){location.reload();},600); }
      else if(st){ st.textContent='✗ '+(j.error||'failed'); st.style.color='#ff9a9a'; }
    }catch(e){ if(st){ st.textContent='✗ '+e.message; st.style.color='#ff9a9a'; } }
  }
  function genSecret(id){
    const b=new Uint8Array(24); crypto.getRandomValues(b);
    const hex=Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
    const el=document.getElementById(id); el.value='whsec_'+hex; el.focus(); el.select();
  }
  function copyField(id){
    const el=document.getElementById(id); el.select();
    navigator.clipboard?.writeText(el.value).then(()=>{ el.style.outline='2px solid #5bd08a'; setTimeout(()=>el.style.outline='',700); });
  }
  async function testEmail(){
    const to=document.getElementById('smtp-test-to').value;
    const el=document.getElementById('smtp-test-result');
    el.textContent='Sending…'; el.style.color='';
    try{
      const r=await fetch('/api/v1/admin/test-email',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':KEY},body:JSON.stringify({to})});
      const j=await r.json();
      el.textContent = j.ok ? ('✓ sent to '+(j.to||'')+' — check inbox/spam') : ('✗ '+(j.error||'failed'));
      el.style.color = j.ok ? '#5bd08a' : '#ff9a9a';
    }catch(e){ el.textContent='✗ '+e.message; el.style.color='#ff9a9a'; }
  }
  function syncDays(gid){
    const boxes=document.querySelectorAll('[data-daygroup="'+gid+'"]');
    const vals=[]; boxes.forEach(b=>{ if(b.checked) vals.push(b.value); });
    const h=document.getElementById(gid); if(h) h.value=vals.join(',');
  }
  function syncPfm(fid){
    const boxes=document.querySelectorAll('[data-pfm="'+fid+'"]');
    const ids=[]; const map={};
    boxes.forEach(b=>{ if(b.checked){ ids.push(b.value); map[b.value]={platform:b.dataset.plat||'',account_name:b.dataset.name||''}; } });
    const a=document.getElementById('pfmaccts-'+fid); if(a) a.value=JSON.stringify(ids);
    const m=document.getElementById('pfmmap-'+fid); if(m) m.value=JSON.stringify(map);
  }
  function renderPfm(fid, accounts){
    const box=document.getElementById('pfmlist-'+fid);
    let selected=[]; try{ selected=JSON.parse(document.getElementById('pfmaccts-'+fid).value||'[]'); }catch(_){}
    if(!accounts.length){ box.innerHTML='<span class="hint">No connected accounts found for that key.</span>'; return; }
    box.innerHTML=accounts.map(function(x){
      const ck=selected.indexOf(x.id)>=0?'checked':'';
      return '<label class="acct"><input type="checkbox" value="'+esc2(x.id)+'" data-pfm="'+fid+'" data-plat="'+esc2(x.platform)+'" data-name="'+esc2(x.name)+'" onchange="syncPfm('+fid+')" '+ck+'> <b>'+esc2(x.platform)+'</b> — '+esc2(x.name)+'</label>';
    }).join('');
    syncPfm(fid);
  }
  async function fetchPfm(fid){
    const st=document.getElementById('pfmstatus-'+fid);
    const keyEl=document.getElementById('pfmkey-'+fid);
    const api_key=keyEl?keyEl.value.trim():'';
    st.textContent='Fetching…'; st.style.color='';
    try{
      const j=await post('funnels/fetch-accounts',{funnel_id:fid, api_key});
      if(!j.ok){ st.textContent='✗ '+(j.error||'failed'); st.style.color='#ff9a9a'; return; }
      renderPfm(fid, j.accounts||[]);
      st.textContent='✓ '+(j.accounts||[]).length+' accounts — tick to include, then Save';
      st.style.color='#5bd08a';
    }catch(e){ st.textContent='✗ '+((e&&e.error)||(e&&e.message)||'failed'); st.style.color='#ff9a9a'; }
  }
  const hash=(location.hash||'#users').slice(1);
  if(document.getElementById('panel-'+hash)) show(hash);
  const e=new URLSearchParams(location.search).get('error');
  if(e){const d=document.getElementById('flash-error'); d.textContent='Error: '+e; d.style.display='block';}
</script>`;
}

function usersPanel({ userList, hasKey, tenantId, key }) {
  const rows = (userList || [])
    .map((u, i) => {
      const isSuper = u.email === users.SUPER_ADMIN_EMAIL;
      const roleSel = users.ROLES
        .map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r}</option>`)
        .join('');
      const forever = !u.plan_ends_at;
      const dateVal = u.plan_ends_at ? new Date(u.plan_ends_at).toISOString().slice(0, 10) : '';
      const lastLogin = u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : '—';
      return `<tr>
        <td>${esc(u.email)}${isSuper ? ' <span class="pill">super</span>' : ''}</td>
        <td><select onchange="saveRole(${i}, '${escJs(u.email)}', this)"${isSuper ? ' disabled title="protected"' : ''}>${roleSel}</select></td>
        <td><div class="planwrap">
          <input id="dt-${i}" type="date" value="${dateVal}"${forever ? ' disabled' : ''} onchange="savePlan(${i}, '${escJs(u.email)}')">
          <label style="margin:0;font-size:.8rem"><input id="fv-${i}" type="checkbox"${forever ? ' checked' : ''} onchange="savePlan(${i}, '${escJs(u.email)}')"> forever</label>
        </div></td>
        <td>${esc(lastLogin)}</td>
        <td><button class="act" onclick="toggleBilling(${i}, '${escJs(u.email)}')">Billing</button><span id="flag-${i}" class="saveflag">saved</span></td>
      </tr>
      <tr id="bill-${i}" style="display:none"><td colspan="5"><div id="billbody-${i}"></div></td></tr>`;
    })
    .join('');

  return `<section class="panel active card" id="panel-users">
    <h2>Users</h2>
    <p class="blurb">Accounts are created when people sign up from the landing page. Change a role or plan end date and it saves instantly — no save button. Users manage their own password in their own login.</p>

    ${hasKey
      ? '<div class="hint">🔒 An access key protects these pages.</div>'
      : '<div class="warn">⚠️ No access key set — these pages (which edit config/secrets and show data) are open on the public URL. Set an access key below when ready. Full sign-in is a later phase.</div>'}

    <fieldset><legend>Users</legend>
      <table><thead><tr><th>Email</th><th>Role</th><th>Plan ends</th><th>Last login</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="hint">No users yet — they appear here after signing up.</td></tr>'}</tbody></table>
      <p class="hint">The super admin (${esc(users.SUPER_ADMIN_EMAIL)}) is protected and cannot be demoted or removed.</p>
    </fieldset>

    <fieldset><legend>Access key (interim page guard)</legend>
      <form method="post" action="access/key" class="row">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Set access key (blank = open / clear)</label>
          <input name="new_key" type="password" placeholder="${hasKey ? '•••• (set)' : 'no key set'}" size="24" autocomplete="off"></div>
        <button class="act" type="submit">Save key</button>
      </form>
      <p class="hint">Stored in the database (not an env var). This is the stopgap until password login is built.</p>
    </fieldset>
  </section>`;
}

function funnelsPanel({ funnelList, funnelConfigs, tenantId, key }) {
  const total = WIZARD_STEPS.length;
  const cards = (funnelList || [])
    .map((f) => {
      const cfg = funnelConfigs[f.id] || {};
      const done = completeness(cfg).filter(Boolean).length;
      const ready = done === total;
      return `<div class="funnelrow">
        <div class="funnelrow-main">
          <div class="funnelrow-name">${esc(f.name)} ${f.active ? '' : '<span class="pill">paused</span>'}</div>
          <div class="funnelrow-meta">${ready ? '🟢 ready' : `🟡 ${done}/${total} steps set`}</div>
        </div>
        <div class="row" style="gap:.4rem;margin:0">
          <a class="act primary" href="/api/v1/admin/funnels/${f.id}/setup">Set up →</a>
          <form method="post" action="/api/v1/admin/funnels/active" style="display:inline">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
            <input type="hidden" name="funnel_id" value="${f.id}"><input type="hidden" name="active" value="${f.active ? 'false' : 'true'}">
            <button class="act" type="submit">${f.active ? 'Pause' : 'Activate'}</button>
          </form>
          <form method="post" action="/api/v1/admin/funnels/remove" style="display:inline" onsubmit="return confirm('Delete funnel ${escJs(f.name)}?')">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
            <input type="hidden" name="funnel_id" value="${f.id}">
            <button class="act danger" type="submit">Delete</button>
          </form>
        </div>
      </div>`;
    })
    .join('');

  return `<section class="panel card" id="panel-funnels">
    <h2>Funnels</h2>
    <p class="blurb">A funnel is a brand/campaign scope with its own content source, social accounts, and schedule. Add one, then open its step-by-step setup — one screen per stage, with Back / Save / Next always in view.</p>
    <fieldset><legend>Add a funnel</legend>
      <form method="post" action="/api/v1/admin/funnels" class="row">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Funnel name</label><input name="name" placeholder="e.g. Divine Leads" size="20"></div>
        <button class="act" type="submit">+ Add funnel</button>
      </form>
    </fieldset>
    <div class="funnellist">${cards || '<p class="hint">No funnels yet — add one above.</p>'}</div>
  </section>`;
}

// ---- video setup wizard (full-page, one step per screen) -------------------

// Step 3 only: generate a couple of real stills now and email them for the
// keep/regenerate review, so the whole gate is testable before the worker.
function imageGateTestBlock() {
  return `<div class="igt">
    <div class="igt-title">Test batch</div>
    <p class="hint">Generate a couple of real stills now and email them for the keep / regenerate review. Uses your OpenAI key and this funnel's Drive folder.</p>
    <div class="row">
      <input id="igt-topic" placeholder="test topic (optional)" style="flex:1;min-width:200px">
      <input id="igt-count" type="number" min="1" max="6" value="2" style="width:72px" title="how many">
      <button type="button" class="act" onclick="imageGateTest()">Generate test batch</button>
      <span id="igt-status" class="hint"></span>
    </div>
  </div>`;
}

function wizardPage({ funnel, cfg, stepIndex, complete }) {
  const total = WIZARD_STEPS.length;
  const step = WIZARD_STEPS[stepIndex];
  const base = `/api/v1/admin/funnels/${funnel.id}/setup`;
  const pct = Math.round(((stepIndex + 1) / total) * 100);

  const rail = WIZARD_STEPS
    .map((s, i) => {
      const state = i === stepIndex ? 'current' : complete[i] ? 'done' : 'todo';
      const marker = complete[i] && i !== stepIndex ? '✓' : String(i + 1);
      return `<button type="button" class="wnav ${state}" data-step="${i}" onclick="nav(${i})">
        <span class="wmark">${marker}</span><span class="wlabel">${esc(s.title)}</span></button>`;
    })
    .join('');

  const directOn = (cfg.research_mode || 'manual') === 'direct';
  const fieldsHtml = step.fields
    .map((field) => {
      if (field.key === 'postforme_api_key') return funnelKeyRow(field, cfg, funnel.id);
      if (field.key === 'postforme_accounts') return pfmAccountsRow(cfg, funnel.id);
      if (field.key === 'account_map') return '';
      const html = fieldRow(field, cfg);
      // Fields tagged group:'direct' only apply to the Direct-upload source — show
      // them only when that source is chosen (toggled client-side on change).
      return field.group === 'direct' ? `<div class="direct-only"${directOn ? '' : ' style="display:none"'}>${html}</div>` : html;
    })
    .join('');

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === total - 1;

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(funnel.name)} — video setup</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 select,input,textarea{background:#0b0b12;color:#fff;border:1px solid #333;border-radius:8px;padding:.55rem;width:100%}
 textarea{min-height:5rem;font-size:.9rem}
 .shell{max-width:980px;margin:1.3rem auto;background:#12121b;border:1px solid #24243a;border-radius:14px;overflow:hidden}
 .top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.3rem;border-bottom:1px solid #24243a}
 .top .brand{font-size:1.05rem;font-weight:700}
 .top .sub{font-size:.8rem;color:#8a8aa2;margin-top:.1rem}
 .stepno{text-align:right}.stepno .k{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8a8aa2}
 .stepno .v{font-size:1.1rem;font-weight:700}.stepno .v small{color:#6f6f88;font-weight:400}
 .bar{height:3px;background:#1c1c2a}.bar>i{display:block;height:3px;background:#2d6cdf;width:${pct}%}
 .body{display:grid;grid-template-columns:230px 1fr;min-height:360px}
 .rail{border-right:1px solid #24243a;padding:.8rem .6rem;display:flex;flex-direction:column;gap:.15rem}
 .wnav{display:flex;align-items:center;gap:.6rem;text-align:left;background:none;border:0;color:#9a9ab0;padding:.5rem .6rem;border-radius:8px;cursor:pointer;font-size:.86rem}
 .wnav:hover{background:#1c1c2a}
 .wnav .wmark{flex:0 0 22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:.72rem;border:1px solid #2a2a44;color:#8a8aa2}
 .wnav.current{background:#15224a;color:#fff}.wnav.current .wmark{background:#2d6cdf;border-color:#2d6cdf;color:#fff}
 .wnav.done{color:#c7c7d9}.wnav.done .wmark{background:#0a7d32;border-color:#0a7d32;color:#fff}
 .main{padding:1.4rem 1.6rem}
 .main h1{font-size:1.25rem;margin:0 0 .25rem;font-weight:600}
 .main .desc{color:#9a9ab0;font-size:.88rem;margin:0 0 1.3rem;line-height:1.55}
 .field{margin:0 0 1rem}.field label{display:block;margin:0 0 .3rem;font-size:.82rem;color:#c7c7d9}
 .hint{color:#6f6f88;font-size:.78rem;margin:.25rem 0 0}
 .igt{margin-top:1.3rem;border-top:1px solid #24243a;padding-top:1rem}
 .igt-title{font-size:.9rem;color:#c7c7d9;margin-bottom:.2rem}
 .igt input{width:auto}
 .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .daychips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.2rem}
 .daychip{display:inline-flex;align-items:center;gap:.3rem;background:#15151f;border:1px solid #2a2a44;border-radius:999px;padding:.3rem .7rem;font-size:.85rem;cursor:pointer}
 .daychip input{width:auto;margin:0}
 input[type=time]{width:auto;min-width:130px}
 .acctlist{display:flex;flex-direction:column;gap:.3rem;margin:.4rem 0;max-height:260px;overflow:auto}
 .acct{display:flex;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.4rem .7rem;font-size:.85rem;cursor:pointer}
 .acct input{width:auto;margin:0}.acct b{color:#c7c7d9;text-transform:capitalize}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.5rem .9rem;cursor:pointer;font-size:.86rem;text-decoration:none;display:inline-flex;align-items:center;gap:.3rem}
 .foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.9rem 1.3rem;border-top:1px solid #24243a;background:#12121b}
 .foot .right{display:flex;gap:.6rem}
 .btn{border:0;border-radius:9px;padding:.6rem 1.2rem;font-size:.92rem;cursor:pointer}
 .btn.back{background:#1c1c2a;color:#c7c7d9}.btn.back[disabled]{opacity:.4;cursor:not-allowed}
 .btn.save{background:#2a2a44;color:#fff}.btn.next{background:#2d6cdf;color:#fff}
 .toast{position:static;margin-top:.8rem;font-size:.82rem;min-height:1rem}
 a.back-link{color:#7aa2ff;font-size:.82rem;text-decoration:none;display:inline-block;margin:1rem auto 2rem;text-align:center;width:100%}
</style>
<div class="shell">
  <div class="top">
    <div><div class="brand">${esc(funnel.name)}</div><div class="sub">video setup${funnel.active ? '' : ' · paused'}</div></div>
    <div class="stepno"><div class="k">Step</div><div class="v">${stepIndex + 1} <small>/ ${total}</small></div></div>
  </div>
  <div class="bar"><i></i></div>
  <div class="body">
    <nav class="rail">${rail}</nav>
    <div class="main">
      <h1>${esc(step.title)}</h1>
      <p class="desc">${esc(step.desc)}</p>
      <form id="wform" onsubmit="return false">${fieldsHtml}</form>
      ${cfg.manual_stepper === 'on' ? `<div class="igt">
        <div class="igt-title">🎛 Manual mode is on for this funnel</div>
        <p class="hint">This screen is the setup. To actually build a video stage-by-stage — Generate/edit each prompt → Execute → Preview → Approve → next → post — start a manual run. Each run opens a page with one card per stage (Script, Images, Image→video, Voiceover, Transcript, Final reel, Post), each with its input, an Execute button, and a Preview.</p>
        <div class="row">
          <button type="button" class="act" onclick="startManualRun()">▶ Start a manual run of this funnel</button>
          <a class="act" href="/api/v1/admin/instances/manual">All manual runs</a>
        </div>
      </div>
      <script>
        async function startManualRun(){
          try{
            const r=await fetch('/api/v1/admin/instances/manual/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnelId:${funnel.id}})});
            const j=await r.json();
            if(j.ok) location.href='/api/v1/admin/instances/'+j.id; else alert(j.error||'failed');
          }catch(e){ alert(e.message); }
        }
      </script>` : ''}
      <div id="toast" class="toast"></div>
    </div>
  </div>
  <div class="foot">
    <button class="btn back" ${isFirst ? 'disabled' : ''} onclick="nav(${stepIndex - 1})">← Back</button>
    <div class="right">
      <button class="btn save" onclick="save()">Save</button>
      <button class="btn next" onclick="${isLast ? 'finish()' : `nav(${stepIndex + 1})`}">${isLast ? 'Finish' : 'Save & Next →'}</button>
    </div>
  </div>
</div>
<a class="back-link" href="/api/v1/admin/settings#funnels">← All funnels</a>
<script>
 const BASE=${JSON.stringify(base)};
 const SAVE_URL=BASE+'/save';
 const ACCOUNTS_URL='/api/v1/admin/funnels/fetch-accounts';
 const STEP=${stepIndex}, TOTAL=${total}, FID=${funnel.id};
 const FUNNEL_BASE='/api/v1/admin/funnels/'+FID;
 function esc2(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
 async function imageGateTest(){
   const st=document.getElementById('igt-status');
   const topic=(document.getElementById('igt-topic')||{}).value||'';
   const count=(document.getElementById('igt-count')||{}).value||'2';
   st.textContent='Starting…';st.style.color='';
   try{
     const r=await fetch(FUNNEL_BASE+'/image-gate/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic,count})});
     const j=await r.json();
     st.textContent=j.ok?('✓ '+(j.message||'started')):('✗ '+(j.error||'failed'));
     st.style.color=j.ok?'#5bd08a':'#ff9a9a';
   }catch(e){st.textContent='✗ '+(e.message||'failed');st.style.color='#ff9a9a';}
 }
 function toast(msg,err){const t=document.getElementById('toast');t.textContent=msg;t.style.color=err?'#ff9a9a':'#5bd08a';if(!err)setTimeout(()=>{if(t.textContent===msg)t.textContent='';},1500);}
 function collectSet(){const set={};document.querySelectorAll('#wform [name^="set["]').forEach(el=>{const m=el.name.match(/^set\\[(.+)\\]$/);if(m)set[m[1]]=el.value;});return set;}
 function updateTicks(complete){if(!complete)return;document.querySelectorAll('.wnav').forEach(n=>{const i=Number(n.dataset.step);if(i===STEP)return;const mk=n.querySelector('.wmark');n.classList.toggle('done',!!complete[i]);n.classList.toggle('todo',!complete[i]);mk.textContent=complete[i]?'✓':String(i+1);});}
 async function save(){
   try{
     const r=await fetch(SAVE_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step:STEP,set:collectSet()})});
     const j=await r.json().catch(()=>({}));
     if(!r.ok||!j.ok){toast('Save failed'+(j.error?': '+j.error:''),true);return false;}
     updateTicks(j.complete);toast('Saved');return true;
   }catch(e){toast('Save failed: '+e.message,true);return false;}
 }
 async function nav(i){if(i<0||i>=TOTAL||i===STEP)return;const ok=await save();if(ok!==false)location.href=BASE+'?step='+i;}
 async function finish(){const ok=await save();if(ok!==false)location.href='/api/v1/admin/settings#funnels';}
 // Show the Direct-upload fields only when the content source is "direct".
 (function(){
   const sel=document.querySelector('#wform [name="set[research_mode]"]');
   function sync(){const on=sel&&sel.value==='direct';document.querySelectorAll('.direct-only').forEach(e=>{e.style.display=on?'':'none';});}
   if(sel){sel.addEventListener('change',sync);sync();}
 })();
 function syncDays(gid){const boxes=document.querySelectorAll('[data-daygroup="'+gid+'"]');const vals=[];boxes.forEach(b=>{if(b.checked)vals.push(b.value);});const h=document.getElementById(gid);if(h)h.value=vals.join(',');}
 function syncPfm(fid){const boxes=document.querySelectorAll('[data-pfm="'+fid+'"]');const ids=[];const map={};boxes.forEach(b=>{if(b.checked){ids.push(b.value);map[b.value]={platform:b.dataset.plat||'',account_name:b.dataset.name||''};}});const a=document.getElementById('pfmaccts-'+fid);if(a)a.value=JSON.stringify(ids);const m=document.getElementById('pfmmap-'+fid);if(m)m.value=JSON.stringify(map);}
 function renderPfm(fid,accounts){const box=document.getElementById('pfmlist-'+fid);let selected=[];try{selected=JSON.parse(document.getElementById('pfmaccts-'+fid).value||'[]');}catch(_){}if(!accounts.length){box.innerHTML='<span class="hint">No connected accounts found for that key.</span>';return;}box.innerHTML=accounts.map(function(x){const ck=selected.indexOf(x.id)>=0?'checked':'';return '<label class="acct"><input type="checkbox" value="'+esc2(x.id)+'" data-pfm="'+fid+'" data-plat="'+esc2(x.platform)+'" data-name="'+esc2(x.name)+'" onchange="syncPfm('+fid+')" '+ck+'> <b>'+esc2(x.platform)+'</b> — '+esc2(x.name)+'</label>';}).join('');syncPfm(fid);}
 async function fetchPfm(fid){const st=document.getElementById('pfmstatus-'+fid);const keyEl=document.getElementById('pfmkey-'+fid);const api_key=keyEl?keyEl.value.trim():'';st.textContent='Fetching…';st.style.color='';try{const r=await fetch(ACCOUNTS_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnel_id:fid,api_key})});const j=await r.json();if(!j.ok){st.textContent='✗ '+(j.error||'failed');st.style.color='#ff9a9a';return;}renderPfm(fid,j.accounts||[]);st.textContent='✓ '+(j.accounts||[]).length+' accounts — tick to include, then Save';st.style.color='#5bd08a';}catch(e){st.textContent='✗ '+(e.message||'failed');st.style.color='#ff9a9a';}}
</script>`;
}

function flowSection(app, tenantId, configMap, key) {
  const m = CONFIG_MANIFEST[app];
  const flow = FLOW_MANIFEST[app];

  const moduleSelect = (moduleKey) => {
    if (!moduleKey) return '';
    const choice = configService.moduleChoice(configMap, app, moduleKey);
    const opt = (v, lbl) => `<option value="${v}"${choice === v ? ' selected' : ''}>${lbl}</option>`;
    return `<div class="flowtoggle"><span>Status</span>
      <select name="mod[${esc(moduleKey)}]">${opt('default', 'Default')}${opt('true', 'On')}${opt('false', 'Off')}</select></div>`;
  };

  const box = (b) => {
    const fields = (b.fieldKeys || [])
      .map((fk) => {
        const field = fieldByKey(app, fk);
        return field ? fieldRow(field, configMap) : '';
      })
      .join('');
    return `<div class="flowbox">
      <div class="flowbox-head"><h4>${esc(b.title)}</h4>${moduleSelect(b.moduleKey)}</div>
      ${b.desc ? `<p class="flowdesc">${esc(b.desc)}</p>` : ''}
      ${fields}
      ${b.info ? `<p class="flowinfo">${esc(b.info)}</p>` : ''}
    </div>`;
  };

  const phases = flow.phases
    .map((phase, i) => {
      const boxes = `<div class="flowrow${phase.columns ? ' cols' : ''}">${phase.boxes.map(box).join('')}</div>`;
      const arrow = i < flow.phases.length - 1 ? '<div class="flowarrow">▼</div>' : '';
      return `<div class="flowphase"><div class="flowphase-label">${esc(phase.label)}</div>${boxes}</div>${arrow}`;
    })
    .join('');

  return `<section class="panel card" id="panel-${esc(app)}">
    <h2>${esc(m.label)}</h2><p class="blurb">${esc(flow.intro || m.blurb)}</p>
    <form method="post" action="/api/v1/admin/settings/save">
      <input type="hidden" name="app" value="${esc(app)}">
      <input type="hidden" name="tenant" value="${esc(tenantId)}">
      <input type="hidden" name="key" value="${esc(key)}">
      <div class="flow">${phases}</div>
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
  </section>`;
}

function appSection(app, tenantId, configMap, key) {
  const m = CONFIG_MANIFEST[app];
  const groups = m.groups
    .map((g) => `<fieldset><legend>${esc(g.title)}</legend>${g.fields.map((f) => fieldRow(f, configMap)).join('')}</fieldset>`)
    .join('');

  const mods = m.modules
    .map((mod) => {
      const choice = configService.moduleChoice(configMap, app, mod.key);
      const opt = (v, lbl) => `<option value="${v}"${choice === v ? ' selected' : ''}>${lbl}</option>`;
      return `<div class="mod"><span>${esc(mod.label)}</span>
        <select name="mod[${esc(mod.key)}]">${opt('default', 'Default')}${opt('true', 'On')}${opt('false', 'Off')}</select></div>`;
    })
    .join('');

  return `<section class="panel card" id="panel-${esc(app)}">
    <h2>${esc(m.label)}</h2><p class="blurb">${esc(m.blurb)}</p>
    <form method="post" action="settings/save">
      <input type="hidden" name="app" value="${esc(app)}">
      <input type="hidden" name="tenant" value="${esc(tenantId)}">
      <input type="hidden" name="key" value="${esc(key)}">
      ${groups}
      ${mods ? `<fieldset><legend>Background jobs (apply to all funnels)</legend><div class="mods">${mods}</div></fieldset>` : ''}
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
  </section>`;
}

function fieldRow(field, configMap) {
  const current = configMap[field.key];
  const has = current !== undefined && current !== null && current !== '';
  if (field.type === 'time') {
    const val = has ? current : (field.default || '');
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="time" name="set[${esc(field.key)}]" value="${esc(val)}" step="60" class="pick"></div>`;
  }
  if (field.type === 'select') {
    const val = has ? current : (field.default || '');
    const opts = (field.options || [])
      .map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
      })
      .join('');
    return `<div class="field"><label>${esc(field.label)}</label>
      <select name="set[${esc(field.key)}]" class="pick">${opts}</select></div>`;
  }
  if (field.type === 'model_select') {
    const val = has ? current : (field.default || field.placeholder || '');
    let cat = {};
    try { cat = JSON.parse(configMap.models_catalog || '{}') || {}; } catch { cat = {}; }
    const list = Array.isArray(cat[field.catalog]) ? cat[field.catalog] : [];
    const provider = String(field.catalog || '').startsWith('gemini') ? 'gemini' : 'openai';
    const pname = provider === 'gemini' ? 'Gemini' : 'OpenAI';
    const opts2 = [...new Set([val, ...list].filter(Boolean))]
      .map((v) => `<option value="${esc(v)}"${String(val) === String(v) ? ' selected' : ''}>${esc(v)}</option>`)
      .join('');
    const hint = list.length
      ? `${list.length} model${list.length === 1 ? '' : 's'} available on your ${pname} key — pick one.`
      : `Save your ${pname} key above, then click Refresh to load the list.`;
    return `<div class="field"><label>${esc(field.label)}</label>
      <div class="row" style="gap:.4rem">
        <select name="set[${esc(field.key)}]" class="pick" style="flex:1">${opts2 || '<option value="">— click Refresh —</option>'}</select>
        <button type="button" class="act" onclick="refreshModels('${provider}')">↻ Refresh</button>
        <span id="mdl-${esc(provider)}" class="hint"></span>
      </div>
      <p class="hint">${hint}</p></div>`;
  }
  if (field.type === 'weekdays') {
    const gid = uniqueId('days');
    const cur = String(has ? current : '').split(',').map((s) => s.trim()).filter(Boolean);
    const days = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
    const chips = days
      .map(([v, l]) => `<label class="daychip"><input type="checkbox" value="${v}" data-daygroup="${gid}"${cur.includes(v) ? ' checked' : ''} onchange="syncDays('${gid}')"> ${l}</label>`)
      .join('');
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="hidden" id="${gid}" name="set[${esc(field.key)}]" value="${esc(cur.join(','))}">
      <div class="daychips">${chips}</div>
      <p class="hint">Tick the days this funnel runs. All unchecked = every day.</p></div>`;
  }
  if (field.type === 'smtp_test') {
    const prefill = configMap.smtp_from || configMap.smtp_user || '';
    return `<div class="field"><label>Send a test email</label>
      <div class="row" style="gap:.4rem">
        <input id="smtp-test-to" type="email" placeholder="recipient (defaults to your From)" value="${esc(prefill)}" style="flex:1;min-width:220px">
        <button type="button" class="act" onclick="testEmail()">Send test</button>
        <span id="smtp-test-result" class="hint"></span>
      </div>
      <p class="hint">Save your SMTP settings first, then send a test to confirm delivery (check spam once).</p></div>`;
  }
  if (field.type === 'generated_secret') {
    const fid = `gs-${field.key}`;
    return `<div class="field"><label>${esc(field.label)}</label>
      <div class="row" style="gap:.4rem">
        <input id="${fid}" type="text" name="set[${esc(field.key)}]" value="${esc(has ? current : '')}"
          placeholder="click Generate" autocomplete="off" style="flex:1;min-width:220px">
        <button type="button" class="act" onclick="genSecret('${fid}')">Generate</button>
        <button type="button" class="act" onclick="copyField('${fid}')">Copy</button>
      </div>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'secret') {
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="password" name="set[${esc(field.key)}]" autocomplete="off"
        placeholder="${has ? '•••• (set — blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'unset')}"></div>`;
  }
/**
 * What a stored secret_json may reveal about itself: the Google service-account
 * identity when it holds one, otherwise the map’s own keys. Ids are not secret —
 * the tokens they point at are, and those are never rendered.
 */
function secretJsonSummary(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return 'Configured.'; }
  if (parsed && parsed.client_email) {
    return `Configured. Share your sheets &amp; Drive folders (Editor) with: <b>${esc(parsed.client_email)}</b>`;
  }
  const ids = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  if (!ids.length) return 'Configured.';
  return `Configured for ${ids.length} id${ids.length === 1 ? '' : 's'}: <b>${esc(ids.join(', '))}</b>`;
}
  if (field.type === 'secret_json') {
    // Write-only: never echo the JSON (it holds private keys or access tokens).
    // Only the non-secret shape is surfaced, so the user can still tell what is set.
    return `<div class="field"><label>${esc(field.label)}</label>
      ${has ? `<p class="hint">🟢 ${secretJsonSummary(current)}</p>` : ''}
      <textarea name="set[${esc(field.key)}]" autocomplete="off"
        placeholder="${has ? '•••• (set — paste new JSON to replace; blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'paste the JSON here')}"></textarea>
      ${field.help ? `<p class="hint">${esc(field.help)}</p>` : ''}</div>`;
  }
  if (field.type === 'json' || field.type === 'textarea') {
    return `<div class="field"><label>${esc(field.label)}</label>
      <textarea name="set[${esc(field.key)}]" placeholder="${field.placeholder ? esc(field.placeholder) : ''}">${esc(has ? current : '')}</textarea></div>`;
  }
  return `<div class="field"><label>${esc(field.label)}</label>
    <input type="text" name="set[${esc(field.key)}]" value="${esc(has ? current : '')}"
      placeholder="${field.placeholder ? esc(field.placeholder) : ''}"></div>`;
}

function gatePage(next = '/api/v1/admin/settings', error = '') {
  const nextName = next.includes('dashboard') ? 'dashboard' : 'settings';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — sign in</title>
<style>body{font-family:system-ui;background:#0b0b12;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}
form{background:#15151f;border:1px solid #24243a;padding:1.5rem;border-radius:12px;min-width:280px}
input{width:100%;padding:.6rem;margin:.6rem 0;border-radius:8px;border:1px solid #333;background:#0b0b12;color:#fff}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#2a2a44;color:#fff;cursor:pointer}
.err{color:#ff9a9a;font-size:.85rem;margin:.2rem 0}</style>
<form method="post" action="/api/v1/admin/login">
  <h1>⚙️ automation</h1>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <input type="hidden" name="next" value="${esc(nextName)}">
  <input name="key" type="password" placeholder="Access key" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button></form>`;
}

// Monotonic id source for widgets that need unique DOM ids within a page.
let _uidSeq = 0;
function uniqueId(prefix = 'u') {
  _uidSeq += 1;
  return `${prefix}-${_uidSeq.toString(36)}`;
}

// Funnel Post-for-Me API key: a normal secret input, but with a stable id so
// the "Fetch accounts" button can read a freshly pasted key before it is saved.
function funnelKeyRow(field, cfg, fid) {
  const has = !!(cfg && cfg[field.key]);
  return `<div class="field"><label>${esc(field.label)}</label>
    <input id="pfmkey-${fid}" type="password" name="set[${esc(field.key)}]" autocomplete="off"
      placeholder="${has ? '•••• (set — blank keeps current)' : 'paste your Post for Me API key'}"></div>`;
}

// Account picker: a Fetch button + checkbox list, backed by two hidden inputs
// (the id array and the id→{platform,account_name} map) the page keeps in JSON.
function pfmAccountsRow(cfg, fid) {
  let ids = [];
  let map = {};
  try { ids = JSON.parse((cfg && cfg.postforme_accounts) || '[]'); } catch { ids = []; }
  try { map = JSON.parse((cfg && cfg.account_map) || '{}'); } catch { map = {}; }
  if (!Array.isArray(ids)) ids = [];
  if (!map || typeof map !== 'object') map = {};
  const pre = ids
    .map((id) => {
      const m = map[id] || {};
      const plat = m.platform || '';
      const name = m.account_name || id;
      return `<label class="acct"><input type="checkbox" value="${esc(id)}" data-pfm="${fid}" data-plat="${esc(plat)}" data-name="${esc(name)}" onchange="syncPfm('${fid}')" checked> <b>${esc(plat)}</b> — ${esc(name)}</label>`;
    })
    .join('');
  return `<div class="field"><label>Post for Me accounts</label>
    <div class="row" style="gap:.4rem;align-items:center">
      <button type="button" class="act" onclick="fetchPfm('${fid}')">↻ Fetch accounts from Post for Me</button>
      <span id="pfmstatus-${fid}" class="hint"></span>
    </div>
    <div id="pfmlist-${fid}" class="acctlist">${pre || '<span class="hint">No accounts yet — click Fetch (uses the Post for Me key from Settings → API Keys) and tick the accounts.</span>'}</div>
    <input type="hidden" id="pfmaccts-${fid}" name="set[postforme_accounts]" value="${esc(JSON.stringify(ids))}">
    <input type="hidden" id="pfmmap-${fid}" name="set[account_map]" value="${esc(JSON.stringify(map))}">
    <p class="hint">One click — no JSON. Tick the accounts this funnel posts to.</p></div>`;
}

// Flatten Post for Me's list response into { id, platform, name } rows.
function normalizeAccounts(data) {
  const arr = Array.isArray(data)
    ? data
    : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.accounts) ? data.accounts : []));
  return arr
    .map((a) => ({
      id: String(a.id ?? a.account_id ?? a.uuid ?? ''),
      platform: String(a.platform ?? a.provider ?? a.type ?? ''),
      name: String(a.username ?? a.name ?? a.display_name ?? a.external_name ?? a.handle ?? a.id ?? ''),
    }))
    .filter((a) => a.id);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escJs(s) {
  return String(s ?? '').replace(/['\\]/g, '\\$&');
}

export default { register };
