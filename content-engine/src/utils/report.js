/**
 * Delivery report builders.
 *
 * Purpose:      Turn delivery-log rows into an email subject + body for the two
 *               daily reports, deterministically and testably.
 * Responsibility: Pure logic; callers supply rows, expected accounts, and now.
 * Dependencies: none.
 */

/**
 * Build the Gita daily report.
 * @param {Array} rows - today's pfm_delivery_log rows for Gita
 * @param {Array<{account_id: string, account_name?: string, platform?: string}>} expected
 * @returns {{ subject: string, body: string, allOk: boolean, empty: boolean }}
 */
export function buildGitaReport(rows, expected) {
  if (!rows || rows.length === 0) {
    return {
      subject: 'No Gita delivery report today',
      body: 'No Gita posts were recorded today.',
      allOk: false,
      empty: true,
    };
  }

  const byAccount = new Map();
  for (const r of rows) byAccount.set(r.account_id, r);

  const lines = [];
  let okCount = 0;
  for (const acc of expected) {
    const row = byAccount.get(acc.account_id);
    const label = acc.account_name || acc.platform || acc.account_id;
    if (!row) {
      lines.push(`MISSING  - ${label}`);
    } else if (row.success) {
      okCount += 1;
      lines.push(`OK       - ${label}`);
    } else {
      lines.push(`FAILED   - ${label}: ${row.error || 'unknown error'}`);
    }
  }

  const total = expected.length;
  const allOk = okCount === total;
  let subject;
  if (allOk) subject = `Gita post live ${okCount}/${total}`;
  else subject = `warning: Gita post ${okCount}/${total}`;

  return { subject, body: lines.join('\n'), allOk, empty: false };
}

/**
 * Build the VidaPulse daily report from the latest rows.
 * @param {Array} rows - latest pfm_delivery_log rows for VidaPulse (any order)
 * @param {Array<{account_id: string, account_name?: string, platform?: string}>} expected
 * @param {Date} now
 * @param {number} [staleHours=26]
 */
export function buildVidapulseReport(rows, expected, now = new Date(), staleHours = 26) {
  if (!rows || rows.length === 0) {
    return { subject: 'VidaPulse: no new post', body: 'No VidaPulse posts recorded.', stale: true, empty: true };
  }

  // Newest row overall.
  const sorted = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const newest = sorted[0];
  const ageHours = (now.getTime() - new Date(newest.created_at).getTime()) / 3_600_000;

  if (ageHours > staleHours) {
    return {
      subject: 'VidaPulse: no new post',
      body: `The most recent VidaPulse post is ${ageHours.toFixed(1)}h old (threshold ${staleHours}h).`,
      stale: true,
      empty: false,
    };
  }

  // Rows belonging to the newest post_id group.
  const group = sorted.filter((r) => r.post_id === newest.post_id);
  const byPlatform = new Map();
  for (const r of group) byPlatform.set((r.platform || r.account_id), r);

  const lines = [];
  let okCount = 0;
  for (const acc of expected) {
    const key = acc.platform || acc.account_id;
    const row = byPlatform.get(key);
    const label = acc.account_name || key;
    if (!row) lines.push(`MISSING  - ${label}`);
    else if (row.success) {
      okCount += 1;
      lines.push(`OK       - ${label}`);
    } else lines.push(`FAILED   - ${label}: ${row.error || 'unknown error'}`);
  }

  const total = expected.length;
  const subject = okCount === total ? `VidaPulse post live ${okCount}/${total}` : `warning: VidaPulse post ${okCount}/${total}`;
  return { subject, body: lines.join('\n'), stale: false, empty: false };
}

export default { buildGitaReport, buildVidapulseReport };
