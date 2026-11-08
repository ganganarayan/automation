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

/** How tall your photo stands, as a share of the picture's height. */
export const CUTOUT_SIZES = { small: 0.45, medium: 0.6, large: 0.75 };
export const CUTOUT_POSITIONS = ['left', 'center', 'right'];

/**
 * Where your background-removed photo goes on the picture (W x H): standing on
 * the bottom edge, at `position`, `size` of the height tall, never wider than
 * 90% of the picture. w x h is the photo's own size. Whole pixels.
 */
export function overlayBox({ W, H, w, h, position = 'right', size = 'medium' }) {
  const share = CUTOUT_SIZES[size] || CUTOUT_SIZES.medium;
  const scale = Math.min((H * share) / h, (W * 0.9) / w);
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const margin = Math.round(W * 0.03);
  const pos = CUTOUT_POSITIONS.includes(position) ? position : 'right';
  const left = pos === 'left' ? margin : pos === 'center' ? Math.round((W - width) / 2) : W - width - margin;
  return { width, height, left: Math.max(0, left), top: Math.max(0, H - height) };
}

export default { festivalCaptions, stateOf, istText, overlayBox, CUTOUT_SIZES, CUTOUT_POSITIONS, X_LIMIT };
