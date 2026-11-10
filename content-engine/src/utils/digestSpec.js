/**
 * The daily email (pure: no I/O).
 *
 * Purpose:      One email a day for all funnels instead of one per post per
 *               funnel: every post's status, with its approval link when it is
 *               waiting on you.
 * Responsibility:
 *               - digestAction: is the evening email or the morning extra due?
 *               - buildDigest: the subject + HTML from the rows.
 * Dependencies: libraryStatus, laneSpec. The date format comes in as fmt.
 *
 * The day runs 08:00 to 08:00 IST, so a wake-up after midnight still counts as
 * that evening's email. GitHub's wake-up can be hours late, so the router's
 * approvals may land after the evening email: the morning extra then carries
 * them, and only when something new is waiting.
 */
import { rowStatus } from './libraryStatus.js';
import { channelIcon } from './laneSpec.js';

export const EVENING_HOUR = 20;
const DAY_START_HOUR = 8;
/** Warn when a funnel's sheet has this many Ready rows (days of posts) or fewer. */
export const LOW_SHEET_DAYS = 3;

/** The funnels whose sheet runs out within LOW_SHEET_DAYS. Uncounted sheets are left out. */
export function lowSheets(stock = []) {
  return stock
    .filter((s) => s && s.imagePosts && Number.isInteger(s.imagePosts.count) && s.imagePosts.count <= LOW_SHEET_DAYS)
    .map((s) => ({ id: s.id, funnel: s.name || 'A funnel', left: s.imagePosts.count }));
}
const MORNING_END_HOUR = 16; // the router's 16:00 approvals belong to the evening email

/** The IST day (yyyy-MM-dd) this moment's email belongs to. */
export function digestDay(now) {
  return now.minus({ hours: DAY_START_HOUR }).toFormat('yyyy-MM-dd');
}

/**
 * Which email is due now: 'evening', 'morning' or ''.
 * @param {object} o
 * @param {import('luxon').DateTime} o.now - in IST
 * @param {string} [o.eveningOn] - the day the evening email last went
 * @param {string} [o.morningOn] - the day the morning extra last went
 * @param {string[]} [o.waitingIds] - instances waiting on an approval now
 * @param {string[]} [o.sentIds] - the ones the last email already carried
 * @param {string} [o.dailyOn] - the IST date the daily run last started (yyyy-MM-dd)
 * @param {boolean} [o.quiet] - nothing holds the app awake (every lane has finished)
 */
export function digestAction({ now, eveningOn = '', morningOn = '', waitingIds = [], sentIds = [], dailyOn = '', quiet = false }) {
  const day = digestDay(now);
  if ((now.hour >= EVENING_HOUR || now.hour < DAY_START_HOUR) && eveningOn !== day) return 'evening';
  // The daily run finished today and the app has gone quiet: its approvals are all made.
  if (quiet && dailyOn && dailyOn === now.toFormat('yyyy-MM-dd') && eveningOn !== day) return 'evening';
  if (now.hour >= DAY_START_HOUR && now.hour < MORNING_END_HOUR && morningOn !== day && waitingIds.some((id) => !sentIds.includes(id))) return 'morning';
  return '';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const CELL = 'padding:8px;border-top:1px solid #ddd;vertical-align:top';

/** One channel, with its link when live and its reason when failed. */
function channelLine(c) {
  const name = esc([c.platform, c.name].filter(Boolean).join(' '));
  if (c.state === 'ok' && c.url) return `${channelIcon(c)} <a href="${esc(c.url)}">${name}</a>`;
  return `${channelIcon(c)} ${name}${c.state === 'failed' && c.error ? ` (${esc(clip(c.error, 120))})` : ''}`;
}

function rowHtml(r, base, fmt) {
  const st = rowStatus(r);
  const note = st.note ? ` (${esc(st.note)})` : '';
  const why = r.note && st.key !== 'posted' && !st.note ? `<div style="color:#666">${esc(clip(r.note, 200))}</div>` : '';
  const action = r.approvalUrl
    ? `<a href="${esc(r.approvalUrl)}" style="background:#0a7d32;color:#fff;padding:6px 10px;border-radius:6px;text-decoration:none;display:inline-block">Approve</a>`
    : `<a href="${esc(`${base}/api/v1/admin/instances/${r.id}`)}">Open</a>`;
  const chans = (r.channels || []).map(channelLine).join('<br>');
  const when = r.posted_at || r.scheduled_for;
  return `<tr>
    <td style="${CELL}">${esc(r.funnel_name || '-')}</td>
    <td style="${CELL}">${esc(r.title || 'Untitled')}${chans ? `<div style="margin-top:4px;font-size:.9em">${chans}</div>` : ''}</td>
    <td style="${CELL}">${st.dot} ${esc(st.label)}${note}${why}</td>
    <td style="${CELL};white-space:nowrap">${esc(fmt(when))}</td>
    <td style="${CELL}">${action}</td>
  </tr>`;
}

function section(title, rows, base, fmt) {
  if (!rows.length) return '';
  return `<h3 style="margin:20px 0 6px">${esc(title)}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left"><th style="padding:8px">Funnel</th><th style="padding:8px">Post</th><th style="padding:8px">Status</th><th style="padding:8px">Date (IST)</th><th style="padding:8px"></th></tr></thead>
      <tbody>${rows.map((r) => rowHtml(r, base, fmt)).join('')}</tbody>
    </table>`;
}

/**
 * The email for one address.
 * @param {object} o
 * @param {object[]} o.rows - instance rows plus { channels, approvalUrl }
 * @param {{funnel: string, reason: string}[]} [o.noPost] - funnels with nothing lined up
 * @param {{funnel: string, left: number}[]} [o.lowSheet] - sheets about to run out
 * @param {string} [o.base] - the app's public URL
 * @param {'evening'|'morning'} [o.action]
 * @param {import('luxon').DateTime} o.now
 * @returns {{ subject: string, html: string, counts: object }|null} null when there is nothing to say
 */
export function buildDigest({ rows = [], noPost = [], lowSheet = [], base = '', action = 'evening', now, fmt }) {
  const by = { approve: [], attention: [], other: [] };
  for (const r of rows) {
    const st = rowStatus(r);
    if (r.approvalUrl || st.key === 'needs_you') by.approve.push(r);
    else if (st.key === 'failed' || st.dot === '🟡') by.attention.push(r);
    else by.other.push(r);
  }
  // The morning extra is only about what is waiting.
  const shown = action === 'morning' ? { approve: by.approve, attention: [], other: [] } : by;
  const n = { approve: shown.approve.length, problems: shown.attention.length + (action === 'morning' ? 0 : noPost.length + lowSheet.length) };
  if (!n.approve && !n.problems && !shown.other.length) return null;

  const bits = [n.approve ? `${n.approve} to approve` : '', n.problems ? `${n.problems} need${n.problems === 1 ? 's' : ''} attention` : ''].filter(Boolean);
  const dot = n.problems ? '🟡' : n.approve ? '🟡' : '🟢';
  const label = action === 'morning' ? 'Morning approvals' : 'Daily posts';
  const subject = `${dot} ${label} ${fmt(now, { withTime: false })}${bits.length ? `: ${bits.join(', ')}` : ''}`;
  const none = action === 'morning' || !noPost.length ? '' : `<h3 style="margin:20px 0 6px">🔴 No post lined up</h3>
    <ul>${noPost.map((d) => `<li><b>${esc(d.funnel)}</b>: ${esc(clip(d.reason, 300))}</li>`).join('')}</ul>`;
  const low = action === 'morning' || !lowSheet.length ? '' : `<h3 style="margin:20px 0 6px">🟡 Sheet running out</h3>
    <ul>${lowSheet.map((d) => `<li><b>${esc(d.funnel)}</b>: ${d.left ? `${d.left} Ready row${d.left === 1 ? '' : 's'} left, about ${d.left} day${d.left === 1 ? '' : 's'} of image posts` : 'no Ready rows left, so no image post can go out'}. Add rows to its sheet.</li>`).join('')}</ul>`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:900px">
    ${section('🟡 Waiting for your approval', shown.approve, base, fmt)}
    ${none}
    ${low}
    ${section('🔴 Needs attention', shown.attention, base, fmt)}
    ${section('🟢 Everything else', shown.other, base, fmt)}
    <p style="color:#666;margin-top:20px">Approved after its time, a post goes out at once. Failed channels: reconnect them in Post for Me and the app posts to just those again.</p>
  </div>`;
  return { subject, html, counts: n };
}

export default { EVENING_HOUR, LOW_SHEET_DAYS, lowSheets, digestDay, digestAction, buildDigest };
