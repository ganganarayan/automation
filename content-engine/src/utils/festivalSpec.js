/**
 * Festival lane rules (pure).
 *
 * Purpose:      The small decisions of a festival post that need no DB or network:
 *               its captions and how its state reads on the page.
 * Dependencies: luxon. (Not utils/time: that needs the app env, and this stays pure.)
 */
import { DateTime } from 'luxon';

// IST is a fixed +05:30: the server's own zone (UTC) never decides it.
const IST = 'UTC+5:30';

/** dd-MM-yyyy HH:mm in IST, '-' when unreadable. */
export function istText(value) {
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value || ''));
  return dt.isValid ? dt.setZone(IST).toFormat('dd-MM-yyyy HH:mm') : '-';
}

export const X_LIMIT = 280;

/** The whole copy for every channel; X gets it cut to fit 280 at a word, with an ellipsis. */
export function festivalCaptions(copy = '') {
  const full = String(copy || '').trim();
  if (full.length <= X_LIMIT) return { full, short: full };
  const cut = full.slice(0, X_LIMIT - 1);
  const at = cut.lastIndexOf(' ');
  return { full, short: `${(at > 200 ? cut.slice(0, at) : cut).trimEnd()}…` };
}

/** One festival post's state as a coloured dot and plain words. */
export function stateOf(r = {}) {
  switch (r.status) {
    case 'running': return { dot: '🟡', text: 'Making the video' };
    case 'image_review': return { dot: '🟡', text: r.autoPost ? 'Video made, posting' : 'Video made, waiting for your approval' };
    case 'approved': return { dot: '🟡', text: 'Sending to the channels' };
    case 'scheduled': return { dot: '🟢', text: r.scheduledFor ? `Scheduled for ${istText(r.scheduledFor)}` : 'Posting now' };
    case 'posted': return { dot: '🟢', text: `Posted${r.postedAt ? ` ${istText(r.postedAt)}` : ''}` };
    case 'partial': return { dot: '🟡', text: 'Posted on some channels only (open it to retry the rest)' };
    case 'failed': return { dot: '🔴', text: `Failed: ${r.note || 'unknown reason'}` };
    default: return { dot: '🟡', text: String(r.status || '') };
  }
}

export default { festivalCaptions, stateOf, istText, X_LIMIT };
