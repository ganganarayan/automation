/**
 * Unified operations dashboard.
 *
 * Purpose:      Render a single browser page covering all three platform
 *               services, with a sidebar menu that switches between an Overview
 *               and a per-service view (wa-gateway, content-engine,
 *               tracking-bridge).
 * Responsibility: Gather the cross-service data (from the shared Postgres) and
 *               render the HTML. Built as a service so it can later be extracted
 *               into a standalone Admin UI unchanged.
 * Dependencies: dashboardReadRepository (wa-gateway + tracking-bridge reads),
 *               content-engine repositories, tenantSettings, time utils.
 */
import * as crossRead from '../repositories/dashboardReadRepository.js';
import * as deliveryLog from '../repositories/pfmDeliveryLogRepository.js';
import * as approvals from '../repositories/approvalRepository.js';
import * as jobs from '../repositories/jobRepository.js';
import { todayKeyIst, isoIst } from '../utils/time.js';

/** Collect data for every service section. */
export async function collect(tenantId = 'default') {
  const day = todayKeyIst();
  const [
    deliverySummary, gitaToday, vidaLatest, pendingApprovals, recentJobs, contentEvents,
    purchases, purchasesCount, trackingEvents,
  ] = await Promise.all([
    // content-engine
    deliveryLog.summaryForDay({ tenantId, dayIst: day }).catch(() => []),
    deliveryLog.forDay({ tenantId, brand: 'gita', dayIst: day }).catch(() => []),
    deliveryLog.latest({ tenantId, brand: 'vidapulse', limit: 10 }).catch(() => []),
    approvals.recent({ tenantId, limit: 12 }).catch(() => []),
    jobs.recent({ tenantId, limit: 12 }).catch(() => []),
    crossRead.recentEvents('content-engine', tenantId, 12),
    // tracking-bridge
    crossRead.recentPurchases(tenantId, 15),
    crossRead.purchasesToday(tenantId),
    crossRead.recentEvents('tracking-bridge', tenantId, 12),
  ]);

  return {
    day,
    content: { deliverySummary, gitaToday, vidaLatest, pendingApprovals, recentJobs, events: contentEvents },
    tracking: { purchases, purchasesCount, events: trackingEvents },
  };
}

/** Render the unified dashboard HTML. */
export async function render(tenantId = 'default', opts = {}) {
  const d = await collect(tenantId);
  const keyQs = opts.key ? `?key=${encodeURIComponent(opts.key)}` : '';

  const countBy = (brand, success) =>
    (d.content.deliverySummary || [])
      .filter((s) => s.brand === brand && s.success === success)
      .reduce((a, s) => a + s.n, 0);

  const pending = (d.content.pendingApprovals || []).filter((a) => a.status === 'pending').length;

  // ---- Overview -----------------------------------------------------------
  const overview = section('overview', `
    <div class="cards">
      ${card('content-engine', 'Delivered today', `${countBy('gita', true) + countBy('vidapulse', true)} ok · ${countBy('gita', false) + countBy('vidapulse', false)} failed`)}
      ${card('content-engine', 'Pending approvals', String(pending))}
      ${card('tracking-bridge', 'Purchases today', String(d.tracking.purchasesCount))}
    </div>
    <p class="hint">Use the menu on the left to drill into each service.</p>
  `);

  // ---- content-engine -----------------------------------------------------
  const content = section('content-engine', `
    <div class="cards">
      ${card('gita', 'Delivered today', `${countBy('gita', true)} ok / ${countBy('gita', false)} failed`)}
      ${card('vidapulse', 'Delivered today', `${countBy('vidapulse', true)} ok / ${countBy('vidapulse', false)} failed`)}
      ${card('approvals', 'Pending', String(pending))}
    </div>

    <h2>Gita delivery today</h2>
    ${table(['platform', 'account', 'status', 'error'],
        (d.content.gitaToday || []).map((r) => [r.platform, r.account_name, statusCell(r.success), r.error || '']))}

    <h2>VidaPulse — latest</h2>
    ${table(['platform', 'account', 'status', 'when'],
        (d.content.vidaLatest || []).map((r) => [r.platform, r.account_name, statusCell(r.success), r.created_at]))}

    <h2>Pending approvals</h2>
    ${table(['kind', 'status', 'created'], (d.content.pendingApprovals || []).map((a) => [a.kind, a.status, a.created_at]))}

    <h2>Recent jobs</h2>
    ${table(['type', 'status', 'attempts', 'error'], (d.content.recentJobs || []).map((j) => [j.type, j.status, j.attempts, j.error || '']))}
  `);

  // ---- tracking-bridge ----------------------------------------------------
  const tracking = section('tracking-bridge', `
    <div class="cards">
      ${card('tracking-bridge', 'Purchases today', String(d.tracking.purchasesCount))}
      ${card('tracking-bridge', 'Recent events', String((d.tracking.events || []).length))}
    </div>

    <h2>Recent CAPI purchases</h2>
    ${d.tracking.purchases === null
      ? unavailable()
      : table(['payment', 'value', 'match signals', 'meta', 'when'],
          (d.tracking.purchases || []).map((r) => {
            const p = r.payload || {};
            const ms = p.matchSignals || {};
            const signals = Object.entries(ms).filter(([, v]) => v).map(([k]) => k).join(', ');
            return [p.paymentId || '', p.value ?? '', signals || '—', p.metaStatus ?? '—', r.created_at];
          }))}

    <h2>Recent events</h2>
    ${eventsTable(d.tracking.events)}
  `);

  const menu = [
    ['overview', 'Overview'],
    ['content-engine', 'content-engine'],
    ['tracking-bridge', 'tracking-bridge'],
  ]
    .map(([id, label], i) => `<button class="nav${i === 0 ? ' active' : ''}" data-target="${id}" onclick="show('${id}')">${label}</button>`)
    .join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — dashboard</title>
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 .layout{display:flex;min-height:100vh}
 aside{width:210px;flex:0 0 210px;background:#12121b;border-right:1px solid #24243a;padding:1rem .6rem}
 aside .brand{font-weight:700;padding:.4rem .6rem 1rem;font-size:1.05rem}
 .nav{display:block;width:100%;text-align:left;background:none;border:0;color:#c7c7d9;
   padding:.6rem .7rem;border-radius:8px;font-size:.95rem;cursor:pointer;margin-bottom:.2rem}
 .nav:hover{background:#1c1c2a}
 .nav.active{background:#2a2a44;color:#fff}
 .configlink{display:block;margin-top:1rem;padding:.6rem .7rem;color:#7aa2ff;text-decoration:none;border-top:1px solid #24243a;font-size:.9rem}
 .configlink:hover{background:#1c1c2a}
 main{flex:1;padding:1.5rem;max-width:1100px}
 header.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
 header.top small{color:#9a9ab0}
 .refresh{background:#2a2a44;color:#fff;border:0;border-radius:8px;padding:.5rem .9rem;cursor:pointer}
 .panel{display:none}.panel.active{display:block}
 .cards{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
 .card{flex:1;min-width:190px;background:#15151f;border:1px solid #24243a;border-radius:10px;padding:1rem}
 .card h3{margin:0 0 .3rem;font-size:.72rem;color:#9a9ab0;text-transform:uppercase;letter-spacing:.05em}
 .card .sub{font-size:.7rem;color:#6f6f88;margin-bottom:.3rem}
 .card .v{font-size:1.5rem;font-weight:700}
 h2{font-size:.95rem;color:#c7c7d9;margin:1.4rem 0 .4rem}
 table{width:100%;border-collapse:collapse;font-size:.88rem;margin:.3rem 0}
 th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #24243a;vertical-align:top}
 th{color:#8a8aa2;font-weight:600}
 .ok{color:#5bd08a}.fail{color:#ff7a7a}.muted{color:#6f6f88}
 .hint{color:#6f6f88;font-size:.85rem}
 pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:.8rem;color:#b9b9cc}
</style>
<div class="layout">
  <aside>
    <div class="brand">⚙️ automation</div>
    ${menu}
    <a class="configlink" href="admin/settings${keyQs}">⚙️ Configure →</a>
  </aside>
  <main>
    <header class="top">
      <small>${d.day} IST · generated ${isoIst()}</small>
      <button class="refresh" onclick="location.reload()">Refresh</button>
    </header>
    ${overview}${content}${tracking}
  </main>
</div>
<script>
function show(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+id));
  document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.target===id));
}
</script>`;
}

// ---- html helpers ----------------------------------------------------------

function section(id, inner) {
  return `<section class="panel${id === 'overview' ? ' active' : ''}" id="panel-${id}">${inner}</section>`;
}

function card(sub, title, value) {
  return `<div class="card"><h3>${esc(title)}</h3><div class="sub">${esc(sub)}</div><div class="v">${esc(value)}</div></div>`;
}

function statusCell(success) {
  return success ? '<span class="ok">OK</span>' : '<span class="fail">FAILED</span>';
}

function unavailable() {
  return `<p class="muted">Data unavailable (service not deployed yet or table missing).</p>`;
}

function eventsTable(events) {
  if (events === null) return unavailable();
  return table(['event', 'detail', 'when'], (events || []).map((e) => [
    e.event_type,
    `<pre>${esc(JSON.stringify(e.payload))}</pre>`,
    e.created_at,
  ]));
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows && rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}"><span class="muted">none</span></td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Render a cell; pass through our own trusted <span>/<pre> markup, escape the rest. */
function cell(c) {
  if (c === undefined || c === null) return '';
  const s = String(c);
  if (s.startsWith('<span') || s.startsWith('<pre')) return s;
  return esc(s);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { collect, render };
