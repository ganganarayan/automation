/**
 * AI cost per tenant (pure HTML) for the owner's Tenants panel.
 *
 * Purpose:      What each tenant's AI work cost this month and the last two,
 *               how much of it is on the owner's bill (the platform keys), and
 *               the margin against the tenant's plan price.
 * Responsibility: costSplit (pure numbers) and costBox (render).
 * Dependencies: planSpec, pfmScope (month helpers).
 *
 * Whose key paid: the owner the entry kept (ledger rows), else the tenant's key
 * history on that IST day, else its keys today. Spend on the tenant's own key
 * is not on the owner's bill.
 */
import { monthlyPrice, USD_INR } from './planSpec.js';
import { usageMonth, monthLabel } from './pfmScope.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The three IST months shown, newest first: ['YYYY-MM', ...]. */
export function lastMonths(now = new Date(), n = 3) {
  const m = usageMonth(now);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}

/**
 * Who owned a provider's key on an IST day, from a tenant's key history
 * ([{ from: ISO, owners }], oldest first). Before the first entry: the first
 * entry's owner. No history: null.
 */
export function ownerOn(history = [], provider, day) {
  if (!Array.isArray(history) || !history.length) return null;
  const end = day ? new Date(`${day}T18:29:59.999Z`).getTime() : Date.now(); // 23:59 IST
  let hit = history[0];
  for (const h of history) if (new Date(h.from).getTime() <= end) hit = h;
  return ((hit && hit.owners) || {})[provider] || null;
}

/**
 * Per tenant per month: { total, onBill, own, byProvider } in USD.
 * @param {Array<{tenant_id, month, day?, provider, key_owner?, usd}>} rows
 * @param {Record<string, Record<string,string>>} keyOwners - tenantId -> provider -> 'tenant'|'platform'|'none' (today)
 * @param {Record<string, Array>} histories - tenantId -> key history
 */
export function costSplit(rows = [], keyOwners = {}, histories = {}) {
  const out = {};
  for (const r of rows || []) {
    const t = String(r.tenant_id);
    const m = String(r.month || String(r.day || '').slice(0, 7));
    const usd = Number(r.usd) || 0;
    const cell = ((out[t] = out[t] || {})[m] = out[t][m] || { total: 0, onBill: 0, own: 0, byProvider: {} });
    cell.total += usd;
    const who = r.key_owner || ownerOn(histories[t], r.provider, r.day) || (keyOwners[t] || {})[r.provider];
    if (who === 'tenant') cell.own += usd; else cell.onBill += usd;
    cell.byProvider[r.provider] = (cell.byProvider[r.provider] || 0) + usd;
  }
  return out;
}

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const inr = (n) => `₹${Math.round((Number(n) || 0) * USD_INR).toLocaleString('en-IN')}`;

export function costBox(tenantList = [], rows = null, now = new Date(), keyOwners = {}, histories = {}) {
  if (!Array.isArray(rows)) return '<fieldset><legend>AI cost per tenant</legend><p class="hint">🟡 Could not read the costs just now. Reload to try again.</p></fieldset>';
  const months = lastMonths(now);
  const split = costSplit(rows, keyOwners, histories);
  const ids = [...new Set([...(tenantList || []).map((t) => String(t.id)), ...Object.keys(split)])];
  const byId = Object.fromEntries((tenantList || []).map((t) => [String(t.id), t]));
  const body = ids.map((id) => {
    const t = byId[id] || { id, name: id, plan: 'custom' };
    const cur = (split[id] || {})[months[0]] || { total: 0, onBill: 0, own: 0, byProvider: {} };
    // A plan bought per funnel or client: the price for what was bought.
    const price = t.parent_id ? null : monthlyPrice(t.plan, { units: t.units || 1, extraUsers: t.extra_users || 0 }, 'INR');
    const margin = price ? Math.round(((price - cur.onBill * USD_INR) / price) * 100) : null;
    const dot = margin === null ? '' : margin >= 50 ? '🟢 ' : margin >= 0 ? '🟡 ' : '🔴 ';
    const top = Object.entries(cur.byProvider).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, v]) => `${esc(p)} ${usd(v)}`).join(', ');
    return `<tr><td>${esc(t.name || id)}</td>
      ${months.map((m) => `<td>${usd(((split[id] || {})[m] || {}).onBill)}</td>`).join('')}
      <td>${inr(cur.onBill)}</td>
      <td>${price ? `₹${price.toLocaleString('en-IN')}` : '-'}</td>
      <td>${margin === null ? '-' : `${dot}${margin}%`}</td>
      <td class="hint">${top || '-'}${cur.own ? `; ${usd(cur.own)} on their own keys` : ''}</td></tr>`;
  }).join('');
  return `<fieldset><legend>AI cost per tenant</legend>
    <p class="hint">What each tenant's runs cost on your keys (the platform keys), from the app's own cost records at the price table's rates, ₹${USD_INR} to the dollar. Spend on a tenant's own key is shown apart and is not on your bill. Margin is this month's plan price against this cost.</p>
    <table><thead><tr><th>Tenant</th>${months.map((m) => `<th>${esc(monthLabel(m))}</th>`).join('')}<th>${esc(monthLabel(months[0]))} in ₹</th><th>Plan price</th><th>Margin</th><th>Most spent on</th></tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="hint">No costs yet.</td></tr>'}</tbody></table>
  </fieldset>`;
}

export default { costBox, costSplit, lastMonths, ownerOn };
