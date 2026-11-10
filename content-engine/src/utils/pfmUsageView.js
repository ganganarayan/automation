/**
 * Post for Me usage box (pure HTML) for the owner's Tenants panel.
 *
 * Purpose:      Show successful posts per tenant per month so the owner can bill.
 * Responsibility: Render only; the counts come from instanceRepository.postUsage.
 * Dependencies: pfmScope.
 */
import { planShare, usageMonth, monthLabel } from './pfmScope.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Successful Post for Me posts per tenant per month (the app's own records), and
 * this month's share of the shared plan ($10 a month for 1,000 posts).
 */
export function usageBox(tenantList = [], postUsage = null, now = new Date(), ownKeyIds = []) {
  const own = new Set((ownKeyIds || []).map(String));
  if (!Array.isArray(postUsage)) return '<fieldset><legend>Post for Me usage</legend><p class="hint">🟡 Could not read the usage just now. Reload to try again.</p></fieldset>';
  const thisMonth = usageMonth(now);
  const months = [thisMonth];
  for (let i = 1; i < 3; i += 1) {
    const d = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const by = {};
  for (const r of postUsage) (by[r.tenant_id] = by[r.tenant_id] || {})[r.month] = Number(r.posts) || 0;
  const names = Object.fromEntries((tenantList || []).map((t) => [String(t.id), t.name || t.id]));
  const ids = [...new Set([...(tenantList || []).map((t) => String(t.id)), ...Object.keys(by)])];
  const now0 = Object.fromEntries(ids.filter((id) => !own.has(id)).map((id) => [id, (by[id] || {})[thisMonth] || 0]));
  const plan = planShare(now0);
  const rows = ids.map((id) => {
    const sh = plan.share[id] || { posts: 0, pct: 0, usd: 0 };
    return `<tr><td>${esc(names[id] || id)}</td>${months.map((m) => `<td>${esc(String((by[id] || {})[m] || 0))}</td>`).join('')}${own.has(id) ? '<td colspan="2" class="hint">own Post for Me key</td>' : `<td>${esc(String(sh.pct))}%</td><td>$${esc(sh.usd.toFixed(2))}</td>`}</tr>`;
  }).join('');
  const dot = plan.overLimit ? '🔴' : plan.total > plan.limit * 0.8 ? '🟡' : '🟢';
  return `<fieldset><legend>Post for Me usage</legend>
    <p class="hint">${dot} ${esc(String(plan.total))} of ${esc(String(plan.limit))} successful posts used in ${esc(monthLabel(thisMonth))} on the shared plan ($${esc(String(plan.priceUsd))} a month for ${esc(String(plan.limit))}, shared by every tenant).${plan.overLimit ? ' Over the plan: ask Post for Me for a bigger one.' : ''}
      One post on one channel counts as one, from this app's own records; a tenant on its own Post for Me key is listed but is not on your bill.</p>
    <table><thead><tr><th>Tenant</th>${months.map((m) => `<th>${esc(monthLabel(m))}</th>`).join('')}<th>Share of ${esc(monthLabel(thisMonth))}</th><th>Of $${esc(String(plan.priceUsd))}</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="hint">No posts yet.</td></tr>'}</tbody></table>
  </fieldset>`;
}

export default { usageBox };
