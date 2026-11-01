/**
 * Module: admin work pages (Today, Calendar, Log and cost).
 *
 * Purpose:      The pages you open every day. Today is the landing page after
 *               sign-in: what needs you, what is live, and what the router
 *               decided for tomorrow. Calendar lays the next 14 days out by IST
 *               day; Log and cost lists the last runs with their real cost and
 *               delivery result. A super admin gets "Re-run tomorrow's check"
 *               per funnel on Today (POST /api/v1/admin/router/rerun).
 * Responsibility: HTTP + auth + HTML rendering. Reads come from
 *               workViewRepository (DB only — no Drive / Post for Me calls, so
 *               page load stays fast).
 * Dependencies: workViewRepository, funnelsRepository, instanceService,
 *               libraryStatus, laneSpec, adminNav, utils/time, accessService,
 *               approvalService (review links).
 *
 * Routes: GET /api/v1/admin            → Today
 *         GET /api/v1/admin/today      the landing page
 *         GET /api/v1/admin/calendar   past 7 + next 14 IST days
 *         GET /api/v1/admin/log        last 30 runs, cost + delivery
 */
import * as views from '../repositories/workViewRepository.js';
import * as funnelsRepo from '../repositories/funnelsRepository.js';
import * as instances from '../services/instanceService.js';
import { reviewPath } from '../services/approvalService.js';
import { libraryStatus, statusText, NEEDS_YOU_STATUSES } from '../utils/libraryStatus.js';
import { laneOf, channelText } from '../utils/laneSpec.js';
import { navHtml, NAV_CSS, NAV_SHELL_CSS, HOME_PATH } from '../utils/adminNav.js';
import { nowIst, formatIst, todayKeyIst, ZONE } from '../utils/time.js';
import { keyOk, currentSession } from '../services/accessService.js';
import { DateTime } from 'luxon';

// The daily router checks tomorrow's plan at this IST time.
const ROUTER_CHECK = '16:00';

// Router lanes, in the order it tries them (1 → 2 → 3).
const LANE_LABEL = { ready_video: 'Lane 1 · Ready video', ai_video: 'Lane 2 · AI video', image: 'Lane 3 · Image post', none: 'Nothing posts' };

export function register(ctx) {
  const { router, log } = ctx;
  const guardHtml = async (req, res) => {
    if (await keyOk(req)) return true;
    res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    return false;
  };

  router.get('/admin', (_req, res) => res.redirect(302, HOME_PATH));

  router.get('/admin/today', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const tenantId = req.tenantId || 'default';
      const now = nowIst();
      const dayStart = now.startOf('day');
      const tomorrow = todayKeyIst(dayStart.plus({ days: 1 }));
      const [session, waiting, images, live, readyLeft, funnels, decisions] = await Promise.all([
        currentSession(req),
        views.needsYou({ tenantId, statuses: NEEDS_YOU_STATUSES }).catch(() => []),
        views.pendingImageApprovals({ tenantId }).catch(() => []),
        views.liveCounts({ tenantId, fromUtc: dayStart.toUTC().toISO(), toUtc: dayStart.plus({ days: 1 }).toUTC().toISO() }).catch(() => null),
        views.readyLeft({ tenantId }).catch(() => null),
        funnelsRepo.listByTenant(tenantId).catch(() => []),
        views.routerDays({ tenantId, fromDay: tomorrow, toDay: tomorrow }),
      ]);
      res.type('html').send(todayPage({ now, tomorrow, session, waiting, images, live, readyLeft, funnels, decisions }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/calendar', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const tenantId = req.tenantId || 'default';
      const today = nowIst().startOf('day');
      const from = today.minus({ days: 7 });
      const to = today.plus({ days: 14 }); // exclusive: today + the next 13 days
      const [session, rows, funnels, decisions] = await Promise.all([
        currentSession(req),
        views.calendarInstances({ tenantId, fromUtc: from.toUTC().toISO(), toUtc: to.toUTC().toISO() }).catch(() => []),
        funnelsRepo.listByTenant(tenantId).catch(() => []),
        views.routerDays({ tenantId, fromDay: todayKeyIst(from), toDay: todayKeyIst(to.minus({ days: 1 })) }),
      ]);
      res.type('html').send(calendarPage({ today, from, to, session, rows, funnels, decisions }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/log', async (req, res, next) => {
    try {
      if (!(await guardHtml(req, res))) return;
      const tenantId = req.tenantId || 'default';
      const monthStart = nowIst().startOf('month');
      const [session, rows, month] = await Promise.all([
        currentSession(req),
        instances.list({ tenantId, limit: 30 }),
        views.costSince({ tenantId, fromUtc: monthStart.toUTC().toISO() }).catch(() => null),
      ]);
      res.type('html').send(logPage({ session, rows, month, monthStart }));
    } catch (err) {
      next(err);
    }
  });

  log.info('admin work pages registered (today, calendar, log)');
}

// ---- rendering -------------------------------------------------------------

function todayPage({ now, tomorrow, session, waiting, images, live, readyLeft, funnels, decisions }) {
  const nextCheck = now.toFormat('HH:mm') < ROUTER_CHECK ? ROUTER_CHECK : `tomorrow ${ROUTER_CHECK}`;
  const needCount = (waiting || []).length + (images || []).length;

  const tiles = `<div class="tiles">
    ${tile('Needs you', String(needCount), needCount ? '🟡 waiting on you' : '🟢 nothing waiting')}
    ${tile('Live today', live ? `${live.posted} posted` : '—', live ? `${live.scheduled} still scheduled today` : 'could not read')}
    ${tile('Ready videos left', readyLeft == null ? '—' : String(readyLeft), 'pulled in, not yet scheduled')}
  </div>`;

  const items = [
    ...(waiting || []).map((r) => `<tr>
      <td>${esc(statusText(r.status))}<div class="hint">${esc(rawLabel(r.status))}</div></td>
      <td>${esc(r.title || 'Untitled')}<div class="hint">${esc(r.funnel_name || '—')}</div></td>
      <td class="hint">${esc(formatIst(r.updated_at))}</td>
      <td><a class="act primary" href="/api/v1/admin/instances/${esc(r.id)}">Review</a></td>
    </tr>`),
    ...(images || []).map((a) => `<tr>
      <td>🟡 Needs you<div class="hint">Image approval</div></td>
      <td>${esc(imageTitle(a))}</td>
      <td class="hint">${esc(formatIst(a.created_at))}</td>
      <td><a class="act primary" href="${esc(reviewPath(a.id))}">Review</a></td>
    </tr>`),
  ].join('');

  const active = (funnels || []).filter((f) => f.active);
  const superAdmin = !!(session && session.role === 'super_admin');
  const byFunnel = new Map((decisions || []).map((d) => [String(d.funnel_id), d]));
  const plan = active
    .map((f) => {
      const d = decisions ? byFunnel.get(String(f.id)) : null;
      const what = d
        ? `${d.lane === 'none' ? '🟡' : '🟢'} ${esc(LANE_LABEL[d.lane] || d.lane)}${d.reason ? `<div class="hint">${esc(d.reason)}</div>` : ''}`
        : `<span class="hint">not checked yet (${ROUTER_CHECK})</span>`;
      const link = d && d.instance_id ? `<a class="act" href="/api/v1/admin/instances/${esc(d.instance_id)}">Open</a>` : '';
      const rerun = superAdmin ? ` <button type="button" class="act" onclick="rerun(${Number(f.id)}, this)">Re-run tomorrow's check</button>` : '';
      return `<tr><td>${esc(f.name)}</td><td>${what}</td><td class="acts">${link}${rerun}</td></tr>`;
    })
    .join('');

  return shell('Today', `
    <div class="top">
      <div><h1>Today</h1><div class="sub">${esc(formatIst(now, { withTime: false }))} · next check ${esc(nextCheck)}</div></div>
    </div>
    ${tiles}
    <h2>Needs you</h2>
    <table>
      <thead><tr><th>Status</th><th>What</th><th>Since</th><th></th></tr></thead>
      <tbody>${items || '<tr><td colspan="4" class="hint">🟢 Nothing is waiting on you.</td></tr>'}</tbody>
    </table>
    <h2>Tomorrow by funnel <span class="hint">${esc(formatIst(DateTime.fromISO(tomorrow, { zone: ZONE }), { withTime: false }))}</span></h2>
    <table>
      <thead><tr><th>Funnel</th><th>Plan</th><th></th></tr></thead>
      <tbody>${plan || '<tr><td colspan="3" class="hint">No active funnels. Activate one under Setup → Funnels.</td></tr>'}</tbody>
    </table>
    <p class="hint">The router tries Lane 1 (the oldest ready video), then Lane 2 (an AI video, when there is credit), then Lane 3 (an image post).</p>
    ${superAdmin ? `<script>
      async function rerun(id, btn){
        if(!confirm("Re-run tomorrow's check for this funnel? What it lined up and you have not approved yet is replaced.")) return;
        btn.disabled=true; btn.textContent='Re-running…';
        try{
          const r=await fetch('/api/v1/admin/router/rerun',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({funnelId:id})});
          const j=await r.json();
          if(!j.ok) throw new Error(j.error||('HTTP '+r.status));
          btn.textContent='Running — reloading in 45 s';
          setTimeout(()=>location.reload(),45000);
        }catch(err){ btn.disabled=false; btn.textContent="Re-run tomorrow's check"; alert('Re-run failed: '+err.message); }
      }
    </script>` : ''}
  `, { current: 'today', session });
}

function calendarPage({ today, from, to, session, rows, funnels, decisions }) {
  const names = new Map((funnels || []).map((f) => [String(f.id), f.name]));
  const lanes = new Map((decisions || []).map((d) => [`${d.funnel_id}|${d.day}`, d]));

  // Bucket instances by the IST day they post (posted_at once out, else the slot).
  const byDay = new Map();
  for (const r of rows || []) {
    const at = ['posted', 'partial'].includes(r.status) && r.posted_at ? r.posted_at : r.scheduled_for;
    if (!at) continue;
    const dt = DateTime.fromJSDate(new Date(at)).setZone(ZONE);
    const key = dt.toFormat('yyyy-MM-dd');
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ r, time: dt.toFormat('HH:mm') });
  }

  const dayRow = (day) => {
    const key = day.toFormat('yyyy-MM-dd');
    const entries = byDay.get(key) || [];
    const covered = new Set(entries.map(({ r }) => String(r.funnel_id)));
    const lines = entries.map(({ r, time }) => {
      const d = lanes.get(`${r.funnel_id}|${key}`);
      const lane = d ? LANE_LABEL[d.lane] || d.lane : laneLabelOf(r);
      return `<div class="ent"><span class="tm">${esc(time)}</span> <a href="/api/v1/admin/instances/${esc(r.id)}">${esc(r.title || 'Untitled')}</a>
        <span class="hint">${esc(r.funnel_name || names.get(String(r.funnel_id)) || '—')} · ${esc(lane)}</span> ${esc(statusText(r.status))}</div>`;
    });
    // Router decisions with no post on that day yet (e.g. "none", or not built).
    for (const d of decisions || []) {
      if (d.day !== key || covered.has(String(d.funnel_id))) continue;
      lines.push(`<div class="ent"><span class="tm">—</span> ${esc(names.get(String(d.funnel_id)) || `Funnel ${d.funnel_id}`)}
        <span class="hint">· ${esc(LANE_LABEL[d.lane] || d.lane)}${d.reason ? ` · ${esc(d.reason)}` : ''}</span> ${d.lane === 'none' ? '🟡 nothing planned' : '⚪ decided, no post yet'}</div>`);
    }
    const label = `${formatIst(day, { withTime: false })} <span class="hint">${esc(day.setLocale('en-IN').toFormat('ccc'))}</span>`;
    return `<tr class="${key === todayKeyIst(today) ? 'today' : ''}"><td class="day">${label}</td>
      <td>${lines.join('') || '<span class="hint">nothing scheduled</span>'}</td></tr>`;
  };

  const past = [];
  for (let d = from; d < today; d = d.plus({ days: 1 })) past.push(dayRow(d));
  const next = [];
  for (let d = today; d < to; d = d.plus({ days: 1 })) next.push(dayRow(d));

  return shell('Calendar', `
    <div class="top">
      <div><h1>Calendar</h1><div class="sub">Next 14 days by IST day. Times are IST.${decisions === null ? ' The daily router has not run yet, so only scheduled posts show.' : ''}</div></div>
    </div>
    <table class="cal"><tbody>${next.join('')}</tbody></table>
    <details class="past"><summary>Past 7 days</summary>
      <table class="cal"><tbody>${past.join('')}</tbody></table>
    </details>
  `, { current: 'calendar', session });
}

function logPage({ session, rows, month, monthStart }) {
  const body = (rows || [])
    .map((r) => {
      const steps = instances.parseSteps(r);
      const pub = (steps.find((s) => s.key === 'publish') || {}).artifacts || {};
      const chans = Array.isArray(pub.channels) ? pub.channels : [];
      const st = libraryStatus(r.status);
      return `<tr class="${st.hidden ? 'mut' : ''}">
        <td class="hint">${esc(formatIst(r.created_at))}</td>
        <td><a href="/api/v1/admin/instances/${esc(r.id)}">${esc(r.title || 'Untitled')}</a><div class="hint">${esc(r.funnel_name || '—')}</div></td>
        <td>${esc(statusText(r.status))}</td>
        <td>${esc(usd(r.cost_usd))}</td>
        <td class="chans">${esc(chans.map(channelText).join(', ')) || '<span class="hint">—</span>'}</td>
      </tr>`;
    })
    .join('');

  return shell('Log and cost', `
    <div class="top">
      <div><h1>Log and cost</h1><div class="sub">The last 30 runs, their real AI cost and where each one posted.</div></div>
      <div class="toprow"><a class="act" href="/api/v1/dashboard">Delivery dashboard (older feeds, tracking-bridge)</a></div>
    </div>
    <div class="tiles">
      ${tile(`Cost since ${formatIst(monthStart, { withTime: false })}`, month ? usd(month.total) : '—', 'this month, all funnels')}
      ${tile('Runs this month', month ? String(month.runs) : '—', 'instances created')}
    </div>
    <table>
      <thead><tr><th>Created</th><th>Video</th><th>Status</th><th>Cost</th><th>Delivery</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="hint">No runs yet.</td></tr>'}</tbody>
    </table>
  `, { current: 'log', session });
}

// ---- helpers ---------------------------------------------------------------

const RAW_LABEL = {
  script_review: 'Script to check',
  transcript_review: 'Transcript to check',
  final_review: 'Final video to check',
  review: 'To check',
  manual: 'Manual run — next stage is yours',
  image_review: 'Image post to approve',
  video_review: 'Ready video to approve',
};

// No router row for that day: infer the lane from the instance itself.
function laneLabelOf(r) {
  if (r.source_type === 'sheet') return LANE_LABEL.image; // router lane 3
  return laneOf(r) === 'ready' ? LANE_LABEL.ready_video : LANE_LABEL.ai_video;
}

function rawLabel(status) {
  return RAW_LABEL[status] || status;
}

function imageTitle(a) {
  const p = a.payload || {};
  return p.funnelName || p.funnel_name || p.topic || 'Images to keep or regenerate';
}

function tile(title, value, sub) {
  return `<div class="tile"><div class="tt">${esc(title)}</div><div class="tv">${esc(value)}</div><div class="hint">${esc(sub)}</div></div>`;
}

function usd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function shell(title, inner, { current = '', session = null } = {}) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — automation</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .wrap{max-width:1040px;margin:1.4rem auto;padding:0 1rem}
${NAV_SHELL_CSS}
${NAV_CSS}
 .top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
 h1{font-size:1.3rem;margin:0}.sub{color:#8a8aa2;font-size:.82rem;margin-top:.2rem}
 h2{font-size:.95rem;color:#c7c7d9;margin:1.4rem 0 .5rem}
 .toprow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .act{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.4rem .8rem;cursor:pointer;font-size:.82rem;text-decoration:none;display:inline-flex;align-items:center;gap:.25rem}
 .act.primary{background:#2d6cdf}
 .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.8rem;margin-bottom:.4rem}
 .tile{background:#12121b;border:1px solid #24243a;border-radius:12px;padding:.9rem 1rem}
 .tt{color:#9a9ab0;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
 .tv{font-size:1.6rem;font-weight:700;margin:.2rem 0}
 td.acts{white-space:nowrap}td.acts .act{margin-left:.3rem}
 table{width:100%;border-collapse:collapse;font-size:.88rem;background:#12121b;border:1px solid #24243a;border-radius:12px;overflow:hidden}
 th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid #1e1e2c;vertical-align:middle}
 th{color:#9a9ab0;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
 td a{color:#7aa2ff}
 .hint{color:#6f6f88;font-size:.8rem}
 tr.mut td{opacity:.55}
 td.chans{font-size:.78rem;min-width:220px;line-height:1.5}
 .cal td{vertical-align:top}.cal td.day{white-space:nowrap;width:9.5rem;color:#c7c7d9}
 .cal tr.today td{background:#161628}.cal tr.today td.day{color:#fff;font-weight:600}
 .ent{padding:.15rem 0}.tm{display:inline-block;min-width:3rem;color:#c7c7d9;font-variant-numeric:tabular-nums}
 details.past{margin-top:1.2rem}details.past summary{cursor:pointer;color:#8a8aa2;font-size:.85rem;margin-bottom:.5rem}
 details.past table{opacity:.6}
</style>
<div class="layout">
  <aside>${navHtml({ current, session })}</aside>
  <main><div class="wrap">${inner}</div></main>
</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register };
