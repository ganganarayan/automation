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
import { CONFIG_MANIFEST, APPS } from '../services/configManifest.js';
import * as configService from '../services/configService.js';
import * as users from '../repositories/usersRepository.js';
import * as funnels from '../repositories/funnelsRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { keyOk, requiredKey, ACCESS_KEY_STORE } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/settings', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send(gatePage());
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
        page({ tenantId, configMap, userList, funnelList, funnelConfigs, hasKey, key: req.query.key || '', saved: req.query.saved }),
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
      res.redirect(`/api/v1/admin/settings?${q.toString()}#${body.app}`);
    } catch (err) {
      next(err);
    }
  });

  // --- Funnels (multi-account content scope) ---
  // Absolute redirect target (relative paths resolve against the POST route,
  // which produced a /admin/funnels/settings 404).
  const backToFunnels = (body) =>
    `/api/v1/admin/settings?${new URLSearchParams({ tenant: body.tenant || 'default', key: body.key || '' })}#funnels`;

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
      if (newKey.trim() === '') await tenantConfig.del(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
      else await tenantConfig.set(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key, newKey);
      res.redirect(`/api/v1/admin/settings?${new URLSearchParams({ tenant: req.body.tenant || 'default', key: newKey })}#users`);
    } catch (err) {
      next(err);
    }
  });

  log.info('config UI routes registered');
}

// ---- rendering -------------------------------------------------------------

function page({ tenantId, configMap, userList, funnelList, funnelConfigs, hasKey, key, saved }) {
  const menu = [['users', 'Users'], ['funnels', 'Funnels'], ...APPS.map((a) => [a, CONFIG_MANIFEST[a].label])]
    .map(([id, label], i) => `<button class="nav${i === 0 ? ' active' : ''}" data-target="${id}" onclick="show('${id}')">${esc(label)}</button>`)
    .join('');

  const appSections = APPS.map((a) => appSection(a, tenantId, configMap, key)).join('');

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
</style>
<div class="layout">
  <aside>
    <div class="brand">⚙️ automation</div>
    ${menu}
    <a class="dash" href="../dashboard${key ? `?key=${encodeURIComponent(key)}` : ''}">← Dashboard</a>
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
  function genSecret(id){
    const b=new Uint8Array(24); crypto.getRandomValues(b);
    const hex=Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
    const el=document.getElementById(id); el.value='whsec_'+hex; el.focus(); el.select();
  }
  function copyField(id){
    const el=document.getElementById(id); el.select();
    navigator.clipboard?.writeText(el.value).then(()=>{ el.style.outline='2px solid #5bd08a'; setTimeout(()=>el.style.outline='',700); });
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
  const cards = (funnelList || [])
    .map((f) => {
      const cfg = funnelConfigs[f.id] || {};
      const fields = funnels.FUNNEL_FIELDS.map((field) => fieldRow(field, cfg)).join('');
      return `<fieldset><legend>${esc(f.name)} ${f.active ? '' : '<span class="pill">paused</span>'}</legend>
        <form method="post" action="/api/v1/admin/funnels/config">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
          <input type="hidden" name="funnel_id" value="${f.id}">
          ${fields}
          <button class="save" type="submit">Save changes</button>
        </form>
        <div class="row" style="margin-top:.5rem">
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
      </fieldset>`;
    })
    .join('');

  return `<section class="panel card" id="panel-funnels">
    <h2>Funnels</h2>
    <p class="blurb">A funnel is a brand/campaign scope with its own content sheet, social accounts, and schedule — one shared template. The daily poster runs once per active funnel. Add as many as you like. The generated image is posted as-is (handle any layout in your image prompt).</p>
    <fieldset><legend>Add a funnel</legend>
      <form method="post" action="/api/v1/admin/funnels" class="row">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="tenant" value="${esc(tenantId)}">
        <div><label style="margin:0 0 .2rem">Funnel name</label><input name="name" placeholder="e.g. Divine Leads" size="20"></div>
        <button class="act" type="submit">+ Add funnel</button>
      </form>
    </fieldset>
    ${cards || '<p class="hint">No funnels yet — add one above.</p>'}
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
      <fieldset><legend>Modules (per tenant)</legend><div class="mods">${mods}</div></fieldset>
      <button class="save" type="submit">Save ${esc(m.label)}</button>
    </form>
  </section>`;
}

function fieldRow(field, configMap) {
  const current = configMap[field.key];
  const has = current !== undefined && current !== null && current !== '';
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
<title>automation — sign in</title>
<style>body{font-family:system-ui;background:#0b0b12;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}
form{background:#15151f;border:1px solid #24243a;padding:1.5rem;border-radius:12px;min-width:280px}
input{width:100%;padding:.6rem;margin:.6rem 0;border-radius:8px;border:1px solid #333;background:#0b0b12;color:#fff}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#2a2a44;color:#fff;cursor:pointer}</style>
<form onsubmit="location.href='settings?key='+encodeURIComponent(document.getElementById('k').value);return false">
  <h1>⚙️ automation</h1><input id="k" type="password" placeholder="Access key" autofocus>
  <button type="submit">Open</button></form>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escJs(s) {
  return String(s ?? '').replace(/['\\]/g, '\\$&');
}

export default { register };
