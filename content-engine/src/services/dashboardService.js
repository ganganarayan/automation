/**
 * Operations dashboard.
 *
 * Purpose:      Render a single browser page showing today's post status, recent
 *               delivery results, pending approvals, and links to the admin
 *               endpoints. Built as a service (not inline HTML in a route) so it
 *               can later be extracted into a standalone Admin UI unchanged.
 * Responsibility: gather the data and render an HTML page.
 * Dependencies: pfmDeliveryLogRepository, approvalRepository, jobRepository,
 *               tenantSettings, time utils.
 */
import * as deliveryLog from '../repositories/pfmDeliveryLogRepository.js';
import * as approvals from '../repositories/approvalRepository.js';
import * as jobs from '../repositories/jobRepository.js';
import { todayKeyIst, isoIst } from '../utils/time.js';

/** Collect dashboard data for a tenant. */
export async function collect(tenantId = 'default') {
  const day = todayKeyIst();
  const [summary, pending, recentJobs, gitaRows, vidaRows] = await Promise.all([
    deliveryLog.summaryForDay({ tenantId, dayIst: day }),
    approvals.recent({ tenantId, limit: 10 }),
    jobs.recent({ tenantId, limit: 10 }),
    deliveryLog.forDay({ tenantId, brand: 'gita', dayIst: day }),
    deliveryLog.latest({ tenantId, brand: 'vidapulse', limit: 10 }),
  ]);
  return { day, summary, pending, recentJobs, gitaRows, vidaRows };
}

/** Render the dashboard HTML. */
export async function render(tenantId = 'default') {
  const d = await collect(tenantId);

  const countBy = (brand, success) =>
    d.summary.filter((s) => s.brand === brand && s.success === success).reduce((a, s) => a + s.n, 0);

  const cards = [
    card('Gita — delivered today', `${countBy('gita', true)} ok / ${countBy('gita', false)} failed`),
    card('VidaPulse — delivered today', `${countBy('vidapulse', true)} ok / ${countBy('vidapulse', false)} failed`),
    card('Pending approvals', String(d.pending.filter((a) => a.status === 'pending').length)),
  ].join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>content-engine — dashboard</title>
<style>
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 header{padding:1.2rem 1.5rem;border-bottom:1px solid #24243a}
 h1{margin:0;font-size:1.2rem}main{padding:1.5rem;max-width:1000px;margin:0 auto}
 .cards{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
 .card{flex:1;min-width:200px;background:#15151f;border:1px solid #24243a;border-radius:10px;padding:1rem}
 .card h3{margin:0 0 .4rem;font-size:.8rem;color:#9a9ab0;text-transform:uppercase;letter-spacing:.05em}
 .card .v{font-size:1.6rem;font-weight:700}
 table{width:100%;border-collapse:collapse;margin:.5rem 0 1.5rem;font-size:.9rem}
 th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #24243a}
 h2{font-size:1rem;color:#c7c7d9;margin-top:1.5rem}
 a{color:#7aa2ff}.ok{color:#5bd08a}.fail{color:#ff7a7a}
</style>
<header><h1>content-engine dashboard</h1><small>${d.day} IST · generated ${isoIst()}</small></header>
<main>
  <div class="cards">${cards}</div>

  <h2>Gita delivery today</h2>
  ${table(['platform', 'account', 'status', 'error'], d.gitaRows.map((r) => [r.platform, r.account_name, statusCell(r.success), r.error || '']))}

  <h2>VidaPulse — latest</h2>
  ${table(['platform', 'account', 'status', 'when'], d.vidaRows.map((r) => [r.platform, r.account_name, statusCell(r.success), r.created_at]))}

  <h2>Pending approvals</h2>
  ${table(['kind', 'status', 'created'], d.pending.map((a) => [a.kind, a.status, a.created_at]))}

  <h2>Recent jobs</h2>
  ${table(['type', 'status', 'attempts', 'error'], d.recentJobs.map((j) => [j.type, j.status, j.attempts, j.error || '']))}

  <h2>Admin endpoints</h2>
  <p><small>All require the <code>X-Admin-Key</code> header.</small></p>
  <ul>
    <li><code>GET /api/v1/admin/pfm-accounts</code> — connected Post for Me accounts</li>
    <li><code>GET /api/v1/admin/jobs</code>, <code>/events</code>, <code>/modules</code>, <code>/config</code>, <code>/approvals</code></li>
  </ul>
</main>`;
}

function card(title, value) {
  return `<div class="card"><h3>${esc(title)}</h3><div class="v">${esc(value)}</div></div>`;
}

function statusCell(success) {
  return success ? '<span class="ok">OK</span>' : '<span class="fail">FAILED</span>';
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${c === undefined || c === null ? '' : String(c).startsWith('<span') ? c : esc(String(c))}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}"><em>none</em></td></tr>`;
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { collect, render };
