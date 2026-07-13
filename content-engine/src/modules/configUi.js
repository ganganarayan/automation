/**
 * Module: tenant-scoped configuration UI (with Access management).
 *
 * Purpose:      Browser interface to configure each app per tenant and to manage
 *               admin identities/roles and page access — the "where do I set up
 *               the flow" surface. Settings write to the shared tenant_config
 *               table (every service's resolver reads it).
 * Responsibility: HTTP wiring + HTML rendering; logic in configService.
 * Dependencies: configService, configManifest, tenantRepository, adminsRepository,
 *               tenantConfigRepository, settings.
 *
 * Access model (no password yet — identities/roles now, sign-in later):
 *   - super_admin: ganganarayan.rns@gmail.com (seeded, protected).
 *   - admin: scoped to a tenant.
 *   - Page access is guarded by a UI-settable access key stored in the DB
 *     (tenant_config default 'access_key'). If unset (and no ADMIN_KEY env), the
 *     pages are open — a banner warns to set one.
 *
 * Routes (guarded by the access key when set):
 *   GET  /api/v1/admin/settings              the config page (?tenant=&key=)
 *   POST /api/v1/admin/settings/save         apply one app's form
 *   POST /api/v1/admin/tenants               create a tenant
 *   POST /api/v1/admin/access/admins         add/update an admin
 *   POST /api/v1/admin/access/admins/remove  remove an admin
 *   POST /api/v1/admin/access/key            set/clear the access key
 */
import { CONFIG_MANIFEST, APPS } from '../services/configManifest.js';
import * as configService from '../services/configService.js';
import * as tenants from '../repositories/tenantRepository.js';
import * as admins from '../repositories/adminsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { keyOk, requiredKey, ACCESS_KEY_STORE } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/settings', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send(gatePage());
      const tenantId = (req.query.tenant || 'default').toString();
      const [tenantList, configMap, adminList, hasKey] = await Promise.all([
        tenants.list().catch(() => [{ id: 'default', name: 'Default Tenant' }]),
        configService.load(tenantId).catch(() => ({})),
        admins.list().catch(() => []),
        requiredKey().then((k) => !!k),
      ]);
      res.type('html').send(
        page({ tenantId, tenantList, configMap, adminList, hasKey, key: req.query.key || '', saved: req.query.saved }),
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
      const q = new URLSearchParams({ tenant: tenantId, key: body.key || '' });
      if (result.errors.length) q.set('error', result.errors.join('; '));
      else q.set('saved', body.app);
      res.redirect(`settings?${q.toString()}#${body.app}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/tenants', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const id = (body.id || '').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!id) return res.status(400).json({ error: 'tenant id required' });
      await tenants.create({ id, name: body.name || id });
      res.redirect(`settings?${new URLSearchParams({ tenant: id, key: body.key || '' })}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/access/admins', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      if (body.email) {
        await admins.upsert({
          email: body.email,
          role: body.role === 'super_admin' ? 'admin' : 'admin',
          tenantId: body.tenant_scope || 'default',
        });
      }
      res.redirect(`settings?${new URLSearchParams({ tenant: body.tenant || 'default', key: body.key || '' })}#access`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/access/admins/remove', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      if (body.email) await admins.remove(body.email);
      res.redirect(`settings?${new URLSearchParams({ tenant: body.tenant || 'default', key: body.key || '' })}#access`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/access/key', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ error: 'unauthorized' });
      const body = req.body || {};
      const newKey = (body.new_key || '').toString();
      if (newKey.trim() === '') await tenantConfig.del(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
      else await tenantConfig.set(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key, newKey);
      // Redirect carrying the new key so the session stays authorized.
      res.redirect(`settings?${new URLSearchParams({ tenant: body.tenant || 'default', key: newKey })}#access`);
    } catch (err) {
      next(err);
    }
  });

  log.info('config UI routes registered');
}

// ---- rendering -------------------------------------------------------------

function page({ tenantId, tenantList, configMap, adminList, hasKey, key, saved }) {
  const menu = [
    ['access', 'Access & Admins'],
    ...APPS.map((a) => [a, CONFIG_MANIFEST[a].label]),
  ]
    .map(([id, label], i) => `<button class="nav${i === 0 ? ' active' : ''}" data-target="${id}" onclick="show('${id}')">${esc(label)}</button>`)
    .join('');

  const tenantOptions = tenantList
    .map((t) => `<option value="${esc(t.id)}"${t.id === tenantId ? ' selected' : ''}>${esc(t.name || t.id)} (${esc(t.id)})</option>`)
    .join('');

  const appSections = APPS.map((a) => appSection(a, tenantId, configMap, key)).join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — configure</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .layout{display:flex;min-height:100vh}
 aside{width:220px;flex:0 0 220px;background:#12121b;border-right:1px solid #24243a;padding:1rem .6rem;position:sticky;top:0;height:100vh;overflow:auto}
 aside .brand{font-weight:700;padding:.4rem .6rem 1rem;font-size:1.05rem}
 .nav{display:block;width:100%;text-align:left;background:none;border:0;color:#c7c7d9;padding:.6rem .7rem;border-radius:8px;font-size:.92rem;cursor:pointer;margin-bottom:.15rem}
 .nav:hover{background:#1c1c2a}.nav.active{background:#2a2a44;color:#fff}
 aside .dash{display:block;margin-top:1rem;color:#7aa2ff;text-decoration:none;font-size:.85rem;padding:.4rem .7rem}
 main{flex:1;padding:1.3rem;max-width:920px}
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
 button.danger{background:#5a1e1e}
 table{width:100%;border-collapse:collapse;font-size:.88rem}
 th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #24243a}
 .flash{background:#123b1f;border:1px solid #1f6b38;color:#8ff0b0;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.9rem}
 .err{background:#3b1212;border:1px solid #6b1f1f;color:#ff9a9a}
 .warn{background:#3a2f12;border:1px solid #7a5a1f;color:#f0d68f;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem}
 .pill{font-size:.72rem;padding:.1rem .5rem;border-radius:999px;border:1px solid #24243a;color:#c7c7d9}
 .pill.super{background:#2a2a44;color:#fff}
 .hint{color:#6f6f88;font-size:.78rem;margin:.2rem 0 0}
 .row{display:flex;gap:.5rem;align-items:end;flex-wrap:wrap}
 a{color:#7aa2ff}
</style>
<div class="layout">
  <aside>
    <div class="brand">⚙️ Configure</div>
    ${menu}
    <a class="dash" href="../dashboard${key ? `?key=${encodeURIComponent(key)}` : ''}">← Dashboard</a>
  </aside>
  <main>
    ${saved ? `<div class="flash">Saved <b>${esc(saved)}</b> for tenant <b>${esc(tenantId)}</b>.</div>` : ''}
    <div id="flash-error" class="flash err" style="display:none"></div>
    <header class="top">
      <form method="get" action="settings" class="row" style="gap:.4rem">
        <input type="hidden" name="key" value="${esc(key)}">
        <div><label style="margin:0 0 .2rem">Tenant</label>
        <select name="tenant" onchange="this.form.submit()">${tenantOptions}</select></div>
        <noscript><button class="act" type="submit">Go</button></noscript>
      </form>
      <form method="post" action="tenants" class="row" style="gap:.4rem">
        <input type="hidden" name="key" value="${esc(key)}">
        <div><label style="margin:0 0 .2rem">New tenant</label><input name="id" placeholder="tenant-id" size="14"></div>
        <div><label style="margin:0 0 .2rem">Name</label><input name="name" placeholder="Display name" size="14"></div>
        <button class="act" type="submit">+ Add</button>
      </form>
    </header>

    ${accessPanel({ adminList, tenantList, tenantId, key, hasKey })}
    ${appSections}

    <p class="hint">Blank fields fall back to the service's environment default. Secrets are never shown — leave blank to keep the current value. Changes apply within ~1 minute.</p>
  </main>
</div>
<script>
  function show(id){
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+id));
    document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.target===id));
    if(history.replaceState) history.replaceState(null,'',location.pathname+location.search+'#'+id);
  }
  const hash=(location.hash||'#access').slice(1);
  if(document.getElementById('panel-'+hash)) show(hash);
  const e=new URLSearchParams(location.search).get('error');
  if(e){const d=document.getElementById('flash-error'); d.textContent='Error: '+e; d.style.display='block';}
</script>`;
}

function accessPanel({ adminList, tenantList, tenantId, key, hasKey }) {
  const rows = (adminList || [])
    .map((a) => {
      const isSuper = a.role === 'super_admin';
      return `<tr>
        <td>${esc(a.email)}</td>
        <td><span class="pill${isSuper ? ' super' : ''}">${esc(a.role)}</span></td>
        <td>${esc(a.tenant_id || 'all')}</td>
        <td>${isSuper ? '<span class="hint">protected</span>' : removeForm(a.email, tenantId, key)}</td>
      </tr>`;
    })
    .join('');

  const tenantOpts = (tenantList || []).map((t) => `<option value="${esc(t.id)}">${esc(t.id)}</option>`).join('');

  return `<section class="panel active card" id="panel-access">
    <h2>Access &amp; Admins</h2>
    <p class="blurb">Manage who administers the platform. Sign-in (password) is not set up yet — this defines identities and roles now.</p>

    ${hasKey
      ? '<div class="hint">🔒 An access key is set — these pages require it.</div>'
      : '<div class="warn">⚠️ No access key set — these pages (which show data and edit secrets) are currently open on the public URL. Set an access key below when ready.</div>'}

    <fieldset><legend>Admins</legend>
      <table><thead><tr><th>Email</th><th>Role</th><th>Tenant</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="hint">none</td></tr>'}</tbody></table>
      <form method="post" action="access/admins" class="row" style="margin-top:.8rem">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Add admin email</label><input name="email" type="email" placeholder="person@example.com" size="24"></div>
        <div><label style="margin:0 0 .2rem">Tenant scope</label><select name="tenant_scope">${tenantOpts}</select></div>
        <button class="act" type="submit">+ Add admin</button>
      </form>
      <p class="hint">The super admin (ganganarayan.rns@gmail.com) is locked and spans all tenants. Everyone else is a tenant-scoped admin.</p>
    </fieldset>

    <fieldset><legend>Access key (protects these pages)</legend>
      <form method="post" action="access/key" class="row">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Set access key (blank = open / clear)</label>
          <input name="new_key" type="password" placeholder="${hasKey ? '•••• (set)' : 'no key set'}" size="24" autocomplete="off"></div>
        <button class="act" type="submit">Save key</button>
      </form>
      <p class="hint">Stored in the database (not an env var). Until a real sign-in is added, open the pages with <code>?key=…</code>. This is a stopgap for the password-based login you'll set up later.</p>
    </fieldset>
  </section>`;
}

function removeForm(email, tenantId, key) {
  return `<form method="post" action="access/admins/remove" style="display:inline">
    <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
    <input type="hidden" name="email" value="${esc(email)}">
    <button class="act danger" type="submit">Remove</button></form>`;
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
        placeholder="${has ? '•••• (set — blank keeps current)' : (field.placeholder ? esc(field.placeholder) : 'unset')}"></div>`;
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
  <h1>⚙️ Configure</h1><input id="k" type="password" placeholder="Access key" autofocus>
  <button type="submit">Open</button></form>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
