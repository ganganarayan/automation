/**
 * Agency reports (pure).
 *
 * Purpose:      The cost CSV an agency bills its clients from, and the one
 *               evening roll-up email of all its clients (docs/agency-build-plan.md,
 *               phase 5).
 * Responsibility: monthRange, costCsv, rollupMail, rollupDue.
 * Dependencies: luxon (IST, fixed +05:30).
 *
 * Every date a person reads is DD-MM-YYYY HH:MM in IST.
 */
import { DateTime } from 'luxon';

const IST = 'UTC+5:30';

/** 'YYYY-MM' (IST) to { fromUtc, toUtc, label 'MM-YYYY' }; a bad value means this month. */
export function monthRange(ym = '', now = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  const start = m
    ? DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: 1 }, { zone: IST })
    : DateTime.fromJSDate(now, { zone: IST }).startOf('month');
  const s = start.isValid ? start : DateTime.fromJSDate(now, { zone: IST }).startOf('month');
  return { fromUtc: s.toUTC().toISO(), toUtc: s.plus({ months: 1 }).toUTC().toISO(), label: s.toFormat('MM-yyyy'), ym: s.toFormat('yyyy-MM') };
}

function ist(v) {
  if (!v) return '';
  const d = DateTime.fromJSDate(new Date(v), { zone: IST });
  return d.isValid ? d.toFormat('dd-MM-yyyy HH:mm') : '';
}

function cell(v) {
  const s = String(v ?? '');
  // Quote every field; a leading = + - @ is made plain text (no spreadsheet formulas).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function channels(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const pub = (list.find((s) => s && s.key === 'publish') || {}).artifacts || {};
  const ch = Array.isArray(pub.channels) ? pub.channels : [];
  return {
    posted: ch.filter((c) => c && c.state === 'ok').map((c) => c.platform).filter(Boolean),
    failed: ch.filter((c) => c && c.state === 'failed').map((c) => c.platform).filter(Boolean),
  };
}

/**
 * One row per run (post) with its client, funnel, dates, channels and cost,
 * then a total per client. names: tenantId -> client name.
 */
export function costCsv(rows = [], names = {}) {
  const head = ['Client', 'Funnel', 'Post', 'Status', 'Made (IST)', 'Posted (IST)', 'Channels posted', 'Channels failed', 'AI cost (USD)'];
  const out = [head.map(cell).join(',')];
  const totals = new Map();
  for (const r of rows) {
    const who = names[r.tenant_id] || r.tenant_id;
    const ch = channels(r.steps);
    const usd = Number(r.cost_usd) || 0;
    totals.set(who, (totals.get(who) || 0) + usd);
    out.push([who, r.funnel_name || '', r.title || '', r.deleted ? `${r.status || ''} (deleted)` : (r.status || ''), ist(r.created_at), ist(r.posted_at), ch.posted.join(' '), ch.failed.join(' '), usd.toFixed(4)].map(cell).join(','));
  }
  out.push('');
  for (const [who, usd] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) out.push([who, 'TOTAL', '', '', '', '', '', '', usd.toFixed(4)].map(cell).join(','));
  return `${out.join('\r\n')}\r\n`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The agency's evening email: one line per client. stats rows as
 * workViewRepository.clientStats. null when there is nothing to say.
 */
export function rollupMail({ agencyName = '', clients = [], stats = [], day = '', base = '' } = {}) {
  const by = new Map((stats || []).map((s) => [String(s.tenant_id), s]));
  const live = (clients || []).filter((c) => c.status !== 'archived');
  if (!live.length) return null;
  let waiting = 0;
  let failed = 0;
  const rows = live.map((c) => {
    const s = by.get(String(c.id)) || {};
    waiting += s.needs_you || 0;
    failed += s.failed_24h || 0;
    return `<tr><td>${esc(c.name)}</td><td>${s.posted_today || 0}</td><td>${s.scheduled_today || 0}</td><td>${s.needs_you ? `🟡 ${s.needs_you}` : 0}</td><td>${s.failed_24h ? `🔴 ${s.failed_24h}` : 0}</td><td>${s.posts_month || 0}</td><td>$${(Number(s.cost_month) || 0).toFixed(2)}</td></tr>`;
  }).join('');
  const subject = `${agencyName}: ${live.length} client${live.length === 1 ? '' : 's'} on ${day}${waiting ? `, ${waiting} waiting on you` : ''}${failed ? `, ${failed} failed` : ''}`;
  const link = base ? `<p><a href="${esc(String(base).replace(/\/+$/, ''))}/api/v1/admin/clients">Open Clients</a></p>` : '';
  const html = `<p>Your clients today, ${esc(day)}.</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
<tr><th align="left">Client</th><th>Posted</th><th>Still to go</th><th>Waiting on you</th><th>Failed, 24 h</th><th>Posts this month</th><th>AI cost this month</th></tr>
${rows}
</table>${link}<p style="color:#888;font-size:12px">The content engine</p>`;
  return { subject, html, counts: { clients: live.length, waiting, failed } };
}

/** Is the roll-up due: after 20:00 IST and not yet sent today ('YYYY-MM-DD' IST in lastDay)? */
export function rollupDue({ now = new Date(), lastDay = '', hour = 20 } = {}) {
  const d = DateTime.fromJSDate(now, { zone: IST });
  const day = d.toFormat('yyyy-MM-dd');
  return { due: d.hour >= hour && String(lastDay || '') !== day, day, label: d.toFormat('dd-MM-yyyy') };
}

export default { monthRange, costCsv, rollupMail, rollupDue };
