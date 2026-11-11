/**
 * Module: the agency's Clients page.
 *
 * Purpose:      An agency's admins see every client with today's numbers, open
 *               one, add a client, archive or bring one back, and choose which
 *               clients each staff member may open (docs/agency-build-plan.md,
 *               phase 3).
 * Responsibility: HTTP + auth + HTML rendering; the rules live in agencyService.
 * Dependencies: agencyService, accessService, adminNav, utils/time.
 *
 * The agency is the signed-in person's own (session.agencyId), whichever
 * workspace they are working in; the super admin may use it while working in
 * an agency workspace. Fields are named client / template, never tenant or
 * funnel, so the tenant guard does not read them as asks for a workspace.
 *
 * Routes: GET  /api/v1/admin/clients
 *         POST /api/v1/admin/clients/add       { id, name, owner_email, daily_time, template }
 *         POST /api/v1/admin/clients/archive   { client, archived }
 *         POST /api/v1/admin/clients/team      { email, role, clients[] }
 *         POST /api/v1/admin/clients/connect-link { client }: a 7-day link to connect channels
 *         GET  /api/v1/admin/clients/costs.csv?month=YYYY-MM   the cost CSV
 *         POST /api/v1/admin/clients/detach    { client, plan }: move a client out
 */
import * as agency from '../services/agencyService.js';
import { keyOk, currentSession } from '../services/accessService.js';
import { navHtml, NAV_CSS, NAV_SHELL_CSS } from '../utils/adminNav.js';
import { formatIst } from '../utils/time.js';

export const CLIENTS_PATH = '/api/v1/admin/clients';

/** The agency this request may manage, or null. */
async function agencyFor(req) {
  const session = await currentSession(req);
  if (!session || session.mustChange) return null;
  if (session.agencyId) return session.agencyId;
  if (session.role === 'super_admin') return req.tenantId || null;
  return null;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/clients', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      const session = await currentSession(req);
      const agencyId = await agencyFor(req);
      if (!agencyId) return res.status(403).type('html').send(shell('Clients', '<h1>Clients</h1><p class="hint">Only an agency\'s admins see this page.</p>', session));
      let data;
      try {
        data = await agency.overview(agencyId);
      } catch (err) {
        return res.status(403).type('html').send(shell('Clients', `<h1>Clients</h1><p class="hint">${esc(err.message)}</p>`, session));
      }
      res.type('html').send(shell('Clients', clientsPage(data, session), session));
    } catch (err) {
      next(err);
    }
  });

  const action = (fn) => async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'Sign in first.' });
      const agencyId = await agencyFor(req);
      if (!agencyId) return res.status(403).json({ ok: false, error: "Only an agency's admins can do this." });
      const session = await currentSession(req);
      const out = await fn(agencyId, req.body || {}, session);
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  };

  router.get('/admin/clients/costs.csv', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).send('Sign in first.');
      const agencyId = await agencyFor(req);
      if (!agencyId) return res.status(403).send("Only an agency's admins can do this.");
      const out = await agency.costCsvFor(agencyId, String(req.query.month || ''));
      res.set('Cache-Control', 'no-store');
      res.attachment(out.filename).type('text/csv; charset=utf-8').send(`\ufeff${out.csv}`);
    } catch (err) {
      res.status(400).send(err.message);
    }
  });
  router.post('/admin/clients/detach', action((agencyId, b) => agency.detachClient(agencyId, String(b.client || ''), String(b.plan || 'brand'))));
  router.post('/admin/clients/add', action((agencyId, b) => agency.addClient(agencyId, b)));
  router.post('/admin/clients/archive', action((agencyId, b) => agency.setArchived(agencyId, String(b.client || ''), b.archived === true || b.archived === 'true')));
  router.post('/admin/clients/connect-link', action((agencyId, b) => agency.connectLink(agencyId, String(b.client || ''))));
  router.post('/admin/clients/team', action((agencyId, b, session) => agency.setTeam(agencyId, session ? session.email : '', b)));

  log.info('agency clients page registered');
}

// ---- rendering -------------------------------------------------------------

function usd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function nums(s) {
  const st = s || {};
  return {
    today: `${st.posted_today || 0} posted, ${st.scheduled_today || 0} to go`,
    waiting: st.needs_you || 0,
    failed: st.failed_24h || 0,
    month: st.posts_month || 0,
    cost: usd(st.cost_month),
  };
}

/** The Clients page body (pure, for tests). */
export function clientsPage(data, session = null) {
  const { agency: a, clients = [], own = null, active = 0, limit = null, posts = null, postsLimit = null, funnels = [], team = [], month = '' } = data || {};
  const cur = session ? String(session.tenantId || '') : '';
  const row = (c) => {
    const n = nums(c.stats);
    const archived = c.status === 'archived';
    return `<tr${archived ? ' class="mut"' : ''}>
      <td><b>${esc(c.name)}</b><div class="hint">${esc(c.id)}${archived ? ' · archived' : ''}${c.id === cur ? ' · you are here' : ''}</div></td>
      <td>${esc(c.dailyTime || '19:00')}</td>
      <td>${esc(n.today)}</td>
      <td>${n.waiting ? `🟡 ${n.waiting}` : '0'}</td>
      <td>${n.failed ? `🔴 ${n.failed}` : '0'}</td>
      <td>${n.month}</td>
      <td>${esc(n.cost)}</td>
      <td class="acts">
        <form method="post" action="/api/v1/admin/workspace" style="display:inline;margin:0"><input type="hidden" name="workspace" value="${esc(c.id)}"><button class="act primary" type="submit"${archived ? ' title="Archived: look only"' : ''}>Open</button></form>
        ${archived ? '' : `<button class="act" type="button" onclick="connectLink('${esc(c.id)}')" title="A link the client opens to connect its own channels, no password shared">Connect link</button>`}
        <button class="act" type="button" onclick="moveOut('${esc(c.id)}')" title="It becomes its own workspace on its own plan">Move out</button>
        <button class="act" type="button" onclick="archive('${esc(c.id)}', ${archived ? 'false' : 'true'})">${archived ? 'Bring back' : 'Archive'}</button>
      </td>
    </tr>`;
  };
  const ownNums = nums(own);
  const full = limit !== null && active >= limit;
  const funnelOpts = funnels.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  const clientBoxes = (member, i) => clients.filter((c) => c.status !== 'archived')
    .map((c) => `<label class="ck"><input type="checkbox" name="cl-${i}" value="${esc(c.id)}"${(member.clients || []).includes(c.id) ? ' checked' : ''}>${esc(c.name)}</label>`)
    .join('') || '<span class="hint">No clients yet.</span>';
  const teamRows = team.map((m, i) => `<tr>
      <td>${esc(m.email)}${session && m.email === session.email ? ' <span class="hint">(you)</span>' : ''}<div class="hint">${m.last_login_at ? `last in ${esc(formatIst(m.last_login_at))}` : 'not signed in yet'}</div></td>
      <td><select id="tr-${i}" onchange="document.getElementById('tc-${i}').style.opacity=this.value==='staff'?1:.4"><option value="admin"${(m.tenant_role || 'admin') === 'admin' ? ' selected' : ''}>Admin: every client</option><option value="staff"${m.tenant_role === 'staff' ? ' selected' : ''}>Staff: ticked clients only</option></select></td>
      <td id="tc-${i}" style="opacity:${m.tenant_role === 'staff' ? 1 : 0.4}">${clientBoxes(m, i)}</td>
      <td class="acts"><button class="act" type="button" data-email="${esc(m.email)}" onclick="saveTeam(${i}, this.dataset.email)">Save</button><span id="ts-${i}" class="hint"></span></td>
    </tr>`).join('');

  return `<div class="top"><div>
      <h1>Clients</h1>
      <div class="sub">${esc(a ? a.name : '')} · ${active} of ${limit === null ? 'unlimited' : limit} clients${posts !== null ? ` · ${posts}${postsLimit === null ? '' : ` of ${postsLimit}`} posts this month, the agency and every client together` : ''}</div>
    </div></div>
    <table>
      <thead><tr><th>Client</th><th>Daily time</th><th>Today</th><th>Waiting on you</th><th>Failed, 24 h</th><th>Posts this month</th><th>AI cost this month</th><th></th></tr></thead>
      <tbody>
        ${clients.map(row).join('') || '<tr><td colspan="8" class="hint">No clients yet. Add the first one below.</td></tr>'}
        <tr class="own"><td><b>Your own workspace</b><div class="hint">${esc(a ? a.id : '')}${a && a.id === cur ? ' · you are here' : ''}</div></td><td></td><td>${esc(ownNums.today)}</td><td>${ownNums.waiting}</td><td>${ownNums.failed}</td><td>${ownNums.month}</td><td>${esc(ownNums.cost)}</td>
          <td class="acts"><form method="post" action="/api/v1/admin/workspace" style="display:inline;margin:0"><input type="hidden" name="workspace" value="${esc(a ? a.id : '')}"><button class="act" type="submit">Open</button></form></td></tr>
      </tbody>
    </table>
    <p class="row" style="margin:.6rem 0"><label class="hint">Cost CSV for <input id="cm" type="month" value="${esc(month)}"></label> <a class="act" id="cmlink" href="${CLIENTS_PATH}/costs.csv?month=${esc(month)}" onclick="this.href='${CLIENTS_PATH}/costs.csv?month='+document.getElementById('cm').value">⬇ Download</a> <span class="hint">One row per post, every client and your own, dates in IST, to bill your clients.</span></p>
    <p class="hint">Open moves you into that client's workspace (the switcher at the top of the menu does the same). An archived client can still be looked at, posts nothing and does not count toward your ${limit === null ? '' : limit + ' '}clients.</p>

    <h2>Add a client</h2>
    <div class="card">
      ${full ? `<p class="hint">🟡 You have ${active} of ${limit} clients. Archive one to add another.</p>` : ''}
      <div class="row">
        <input id="nc-name" placeholder="Client name">
        <input id="nc-id" placeholder="id, e.g. acme-foods">
        <input id="nc-email" placeholder="Client owner's email">
        <label class="hint">Daily time <input id="nc-time" type="time" value="19:00"></label>
        <select id="nc-template"><option value="">Start with no funnel</option>${funnelOpts ? `<optgroup label="Copy one of your funnels">${funnelOpts}</optgroup>` : ''}</select>
        <button class="act primary" type="button" onclick="addClient()"${full ? ' disabled' : ''}>➕ Add client</button>
      </div>
      <p class="hint">The client gets its own workspace and sign-in, uses your AI keys unless it adds its own, and ends when your plan does. Your system prompts and Music box are copied in. A copied funnel brings its style and times only: connect the client's own channels, Drive and links in it.</p>
      <p id="nc-st" class="hint"></p>
    </div>

    <h2>Your team</h2>
    <table>
      <thead><tr><th>Person</th><th>Role</th><th>Clients they may open</th><th></th></tr></thead>
      <tbody>${teamRows || '<tr><td colspan="4" class="hint">Only you so far. Add people in Users.</td></tr>'}</tbody>
    </table>
    <p class="hint">An admin opens every client. Staff open only the clients ticked for them. Add people to your team from Users in your own workspace.</p>

    <script>
      const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!j.ok) throw new Error(j.error || 'failed'); return j; };
      async function addClient() {
        const st = document.getElementById('nc-st'); const v = (id) => document.getElementById(id).value.trim();
        st.textContent = 'Adding…'; st.style.color = '';
        try {
          const j = await post('${CLIENTS_PATH}/add', { name: v('nc-name'), id: v('nc-id'), owner_email: v('nc-email'), daily_time: v('nc-time'), template: v('nc-template') });
          st.style.color = '#5bd08a';
          st.textContent = '🟢 Added ' + j.tenant + '. ' + (j.emailed ? 'An invite email went to ' + j.email + '. ' : 'No invite email went out (' + (j.emailError || 'mail is not set up') + '): send it yourself. ') + 'Sign-in: ' + j.email + ', one-time password: ' + j.tempPassword + '. It is not shown again.' + (j.copied && j.copied.funnel ? ' Funnel copied: ' + j.copied.funnel + '.' : '');
        } catch (e) { st.style.color = '#ff9a9a'; st.textContent = '🔴 ' + e.message; }
      }
      async function connectLink(client) {
        try {
          const j = await post('${CLIENTS_PATH}/connect-link', { client });
          try { await navigator.clipboard.writeText(j.url); } catch (e) { /* show it instead */ }
          prompt('Send this link to ' + client + '. It works until ' + j.expires + ' and replaces any older link. (Copied.)', j.url);
        } catch (e) { alert(e.message); }
      }
      async function moveOut(client) {
        const plan = prompt('Move ' + client + ' out of your agency? It becomes its own workspace with its own bill, keeps its funnels, posts and people, and stops using your keys. Channels connected on your own Post for Me key must be connected again.\n\nIts plan: type brand (Always-On Brand, 1 funnel).', 'brand');
        if (!plan) return;
        try { const j = await post('${CLIENTS_PATH}/detach', { client, plan: plan.trim().toLowerCase() }); alert(client + ' is now its own workspace on ' + j.plan + ' until ' + j.expires + '. The owner renews it on Tenants.'); location.reload(); } catch (e) { alert(e.message); }
      }
      async function archive(client, archived) {
        if (archived && !confirm('Archive ' + client + '? It stops posting and can only be looked at. You can bring it back later.')) return;
        try { await post('${CLIENTS_PATH}/archive', { client, archived }); location.reload(); } catch (e) { alert(e.message); }
      }
      async function saveTeam(i, email) {
        const st = document.getElementById('ts-' + i);
        const role = document.getElementById('tr-' + i).value;
        const clients = [...document.querySelectorAll('input[name="cl-' + i + '"]:checked')].map((x) => x.value);
        try { await post('${CLIENTS_PATH}/team', { email, role, clients }); st.textContent = ' 🟢 saved'; } catch (e) { st.textContent = ' 🔴 ' + e.message; }
      }
    </script>`;
}

function shell(title, inner, session) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}, automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:1100px;margin:1.4rem auto;padding:0 1rem}
${NAV_SHELL_CSS}
${NAV_CSS}
 .top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
 h1{font-size:1.3rem;margin:0}.sub{color:#8a8aa2;font-size:.82rem;margin-top:.2rem}
 h2{font-size:.95rem;color:#c7c7d9;margin:1.6rem 0 .5rem}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.4rem .8rem;cursor:pointer;font-size:.82rem;text-decoration:none;display:inline-flex;align-items:center;gap:.25rem}
 .act.primary{background:#2d6cdf}.act[disabled]{opacity:.45;cursor:not-allowed}
 td.acts{white-space:nowrap}td.acts .act{margin-left:.3rem}
 table{width:100%;border-collapse:collapse;font-size:.88rem;background:#12121b;border:1px solid #24243a;border-radius:12px;overflow:hidden}
 th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid #1e1e2c;vertical-align:middle}
 th{color:#9a9ab0;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
 tr.mut td{opacity:.55}tr.own td{background:#10101a}
 .hint{color:#6f6f88;font-size:.8rem}
 .card{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:.9rem 1rem}
 .row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
 input,select{background:#1c1c2a;color:#fff;border:1px solid #2a2a44;border-radius:8px;padding:.42rem .55rem;font-size:.86rem;font-family:inherit}
 .ck{display:inline-flex;align-items:center;gap:.25rem;margin:0 .7rem .2rem 0;font-size:.82rem}
</style>
<div class="layout">
  <aside>${navHtml({ current: 'clients', session })}</aside>
  <main><div class="wrap">${inner}</div></main>
</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register, clientsPage, CLIENTS_PATH };
