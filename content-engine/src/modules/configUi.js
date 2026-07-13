/**
 * Module: tenant-scoped configuration UI.
 *
 * Purpose:      Provide a browser interface to configure each app per tenant —
 *               the "where do I set up the flow" surface. Edits are written to
 *               the shared tenant_config table, which every service's settings
 *               resolver reads (env vars act as the default-tenant fallback).
 * Responsibility: HTTP wiring + HTML rendering; logic lives in configService.
 * Dependencies: configService, configManifest, tenantRepository, settings.
 *
 * Routes (gated by ADMIN_KEY via ?key= or X-Admin-Key):
 *   GET  /api/v1/admin/settings           the config page (?tenant=&key=)
 *   POST /api/v1/admin/settings/save      apply one app's form
 *   POST /api/v1/admin/tenants            create a tenant
 */
import { CONFIG_MANIFEST, APPS } from '../services/configManifest.js';
import * as configService from '../services/configService.js';
import * as tenants from '../repositories/tenantRepository.js';
import { settings } from '../settings/index.js';

function keyOk(req) {
  const adminKey = settings.auth.adminKey;
  if (!adminKey) return true; // open in dev when unset
  const provided = req.query.key || req.headers['x-admin-key'] || (req.body && req.body.key);
  return provided === adminKey;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/settings', async (req, res, next) => {
    try {
      if (!keyOk(req)) return res.status(401).type('html').send(gatePage());
      const tenantId = (req.query.tenant || 'default').toString();
      const [tenantList, configMap] = await Promise.all([
        tenants.list().catch(() => [{ id: 'default', name: 'Default Tenant' }]),
        configService.load(tenantId).catch(() => ({})),
      ]);
      res.type('html').send(page({ tenantId, tenantList, configMap, key: req.query.key || '', saved: req.query.saved }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/settings/save', async (req, res, next) => {
    try {
      if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const app = body.app;
      const tenantId = (body.tenant || 'default').toString();
      const submitted = { settings: body.set || {}, modules: body.mod || {} };
      const result = await configService.save(tenantId, app, submitted);
      const q = new URLSearchParams({ tenant: tenantId, key: body.key || '' });
      if (result.errors.length) q.set('error', result.errors.join('; '));
      else q.set('saved', app);
      res.redirect(`settings?${q.toString()}#${app}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/tenants', async (req, res, next) => {
    try {
      if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const id = (body.id || '').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!id) return res.status(400).json({ error: 'tenant id required' });
      await tenants.create({ id, name: body.name || id });
      const q = new URLSearchParams({ tenant: id, key: body.key || '' });
      res.redirect(`settings?${q.toString()}`);
    } catch (err) {
      next(err);
    }
  });

  log.info('config UI routes registered');
}

// ---- rendering -------------------------------------------------------------

function page({ tenantId, tenantList, configMap, key, saved }) {
  const tenantOptions = tenantList
    .map((t) => `<option value="${esc(t.id)}"${t.id === tenantId ? ' selected' : ''}>${esc(t.name || t.id)} (${esc(t.id)})</option>`)
    .join('');

  const appNav = APPS.map((a) => `<a class="tab" href="#${a}">${esc(CONFIG_MANIFEST[a].label)}</a>`).join('');
  const appSections = APPS.map((a) => appSection(a, tenantId, configMap, key)).join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — configure</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 header{position:sticky;top:0;background:#12121b;border-bottom:1px solid #24243a;padding:.9rem 1.2rem;z-index:5}
 header .row{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
 .brand{font-weight:700;font-size:1.05rem;margin-right:.5rem}
 select,input,textarea{background:#0b0b12;color:#fff;border:1px solid #333;border-radius:8px;padding:.5rem}
 textarea{width:100%;min-height:4.5rem;font-family:ui-monospace,monospace;font-size:.82rem}
 .tabs{margin-top:.7rem;display:flex;gap:.5rem;flex-wrap:wrap}
 .tab{color:#c7c7d9;text-decoration:none;padding:.35rem .7rem;border:1px solid #24243a;border-radius:999px;font-size:.85rem}
 main{max-width:900px;margin:0 auto;padding:1.2rem}
 section.app{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:1.2rem;margin-bottom:1.4rem}
 section.app h2{margin:0 0 .2rem}
 .blurb{color:#8a8aa2;font-size:.85rem;margin:0 0 1rem}
 fieldset{border:1px solid #24243a;border-radius:10px;margin:0 0 1rem;padding:.8rem 1rem}
 legend{color:#9a9ab0;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;padding:0 .4rem}
 label{display:block;margin:.6rem 0 .2rem;font-size:.85rem;color:#c7c7d9}
 .field input,.field select{width:100%}
 .mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.6rem}
 .mod{display:flex;justify-content:space-between;align-items:center;gap:.5rem;background:#15151f;border:1px solid #24243a;border-radius:8px;padding:.5rem .7rem}
 .mod span{font-size:.85rem}
 .save{margin-top:.6rem;background:#0a7d32;color:#fff;border:0;border-radius:8px;padding:.6rem 1.3rem;font-size:.95rem;cursor:pointer}
 .flash{background:#123b1f;border:1px solid #1f6b38;color:#8ff0b0;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.9rem}
 .err{background:#3b1212;border:1px solid #6b1f1f;color:#ff9a9a}
 .hint{color:#6f6f88;font-size:.78rem;margin:.2rem 0 0}
 a{color:#7aa2ff}
 .newt{display:flex;gap:.4rem;align-items:center}
</style>
<header>
  <div class="row">
    <span class="brand">⚙️ Configure</span>
    <form method="get" action="settings" class="row" style="gap:.4rem">
      <input type="hidden" name="key" value="${esc(key)}">
      <label style="margin:0">Tenant</label>
      <select name="tenant" onchange="this.form.submit()">${tenantOptions}</select>
      <noscript><button type="submit">Go</button></noscript>
    </form>
    <form method="post" action="tenants" class="newt">
      <input type="hidden" name="key" value="${esc(key)}">
      <input name="id" placeholder="new-tenant-id" size="14">
      <input name="name" placeholder="Display name" size="14">
      <button type="submit">+ Tenant</button>
    </form>
  </div>
  <div class="tabs">${appNav}</div>
</header>
<main>
  ${saved ? `<div class="flash">Saved <b>${esc(saved)}</b> for tenant <b>${esc(tenantId)}</b>.</div>` : ''}
  ${flashError()}
  <p class="hint">Blank fields fall back to the service's environment default. Secrets are never shown — leave blank to keep the current value. Changes apply within ~1 minute.</p>
  ${appSections}
</main>
<script>
  // Surface an ?error= message if present.
  const p=new URLSearchParams(location.search); const e=p.get('error');
  if(e){const d=document.getElementById('flash-error'); if(d){d.textContent='Error: '+e; d.style.display='block';}}
</script>`;
}

function flashError() {
  return `<div id="flash-error" class="flash err" style="display:none"></div>`;
}

function appSection(app, tenantId, configMap, key) {
  const m = CONFIG_MANIFEST[app];
  const groups = m.groups
    .map(
      (g) => `<fieldset><legend>${esc(g.title)}</legend>${g.fields.map((f) => fieldRow(f, configMap)).join('')}</fieldset>`,
    )
    .join('');

  const mods = m.modules
    .map((mod) => {
      const choice = configService.moduleChoice(configMap, app, mod.key);
      const opt = (v, lbl) => `<option value="${v}"${choice === v ? ' selected' : ''}>${lbl}</option>`;
      return `<div class="mod"><span>${esc(mod.label)}</span>
        <select name="mod[${esc(mod.key)}]">${opt('default', 'Default')}${opt('true', 'On')}${opt('false', 'Off')}</select></div>`;
    })
    .join('');

  return `<section class="app" id="${esc(app)}">
    <h2>${esc(m.label)}</h2>
    <p class="blurb">${esc(m.blurb)}</p>
    <form method="post" action="settings/save">
      <input type="hidden" name="app" value="${esc(app)}">
      <input type="hidden" name="tenant" value="${esc(tenantId)}">
      <input type="hidden" name="key" value="${esc(key)}">
      ${groups}
      <fieldset><legend>Modules (per tenant)</legend><div class="mods">${mods}</div></fieldset>
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
  </section>`;
}

function fieldRow(field, configMap) {
  const current = configMap[field.key];
  const has = current !== undefined && current !== null && current !== '';
  if (field.type === 'secret') {
    return `<div class="field"><label>${esc(field.label)}</label>
      <input type="password" name="set[${esc(field.key)}]" autocomplete="off"
        placeholder="${has ? '•••• (set — blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'unset')}">
    </div>`;
  }
  if (field.type === 'json' || field.type === 'textarea') {
    return `<div class="field"><label>${esc(field.label)}</label>
      <textarea name="set[${esc(field.key)}]" placeholder="${field.placeholder ? esc(field.placeholder) : ''}">${esc(has ? current : '')}</textarea></div>`;
  }
  return `<div class="field"><label>${esc(field.label)}</label>
    <input type="text" name="set[${esc(field.key)}]" value="${esc(has ? current : '')}"
      placeholder="${field.placeholder ? esc(field.placeholder) : 'env default'}"></div>`;
}

function gatePage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — configure</title>
<style>body{font-family:system-ui;background:#0b0b12;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}
form{background:#15151f;border:1px solid #24243a;padding:1.5rem;border-radius:12px;min-width:280px}
input{width:100%;padding:.6rem;margin:.6rem 0;border-radius:8px;border:1px solid #333;background:#0b0b12;color:#fff}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#2a2a44;color:#fff;cursor:pointer}</style>
<form onsubmit="location.href='settings?key='+encodeURIComponent(document.getElementById('k').value);return false">
  <h1>⚙️ Configure</h1><input id="k" type="password" placeholder="Admin key" autofocus>
  <button type="submit">Open</button></form>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
