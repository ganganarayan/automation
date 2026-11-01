/**
 * Library status labels (pure).
 *
 * Purpose:      The instance table has a dozen raw statuses (script_review,
 *               transcript_review, draft, partial, ...). People only need to
 *               know where a video stands, so every admin page shows one of
 *               seven plain labels with the colour-dot convention:
 *               🟢 OK · 🟡 needs attention · 🔴 failed. ⚪ / 🔵 are neutral
 *               (not started / in progress).
 * Responsibility: Map raw status → { key, label, dot, note, hidden }. No I/O.
 * Dependencies: none.
 */

/** The labels, in the order the filter chips show them. */
export const LIBRARY_LABELS = [
  { key: 'inbox', label: 'Inbox', dot: '⚪' },
  { key: 'preparing', label: 'Preparing', dot: '🔵' },
  { key: 'needs_you', label: 'Needs you', dot: '🟡' },
  { key: 'ready', label: 'Ready', dot: '🟢' },
  { key: 'scheduled', label: 'Scheduled', dot: '🟢' },
  { key: 'posted', label: 'Posted', dot: '🟢' },
  { key: 'failed', label: 'Failed', dot: '🔴' },
];

// Raw instance status → label key. Unknown statuses read as Preparing.
const STATUS_TO_LABEL = {
  draft: 'inbox',
  running: 'preparing',
  // Waiting on a person: a script / transcript / final check, or a manual run
  // whose next stage is executed by hand.
  script_review: 'needs_you',
  transcript_review: 'needs_you',
  final_review: 'needs_you',
  image_review: 'needs_you', // router lane 3: sheet image waiting for approval
  video_review: 'needs_you', // router lane 1: generated copy waiting for approval
  review: 'needs_you',
  manual: 'needs_you',
  approved: 'ready',
  ready: 'ready',
  scheduled: 'scheduled',
  posted: 'posted',
  done: 'posted',
  partial: 'posted',
  failed: 'failed',
};

/** Raw statuses that wait on the user (the Today page's "Needs you" list). */
export const NEEDS_YOU_STATUSES = Object.keys(STATUS_TO_LABEL).filter((s) => STATUS_TO_LABEL[s] === 'needs_you');

/**
 * One raw status → how the Library shows it.
 * @param {string} status
 * @returns {{ key: string, label: string, dot: string, note: string, hidden: boolean }}
 */
export function libraryStatus(status) {
  const s = String(status || '');
  if (s === 'superseded') return { key: 'superseded', label: 'Replaced', dot: '⚫', note: '', hidden: true };
  const key = STATUS_TO_LABEL[s] || 'preparing';
  const base = LIBRARY_LABELS.find((l) => l.key === key);
  // Partly posted: some channels went out, some did not — attention, not OK.
  if (s === 'partial') return { key, label: base.label, dot: '🟡', note: 'partly', hidden: false };
  return { key, label: base.label, dot: base.dot, note: '', hidden: false };
}

/** The raw statuses that fall under a label key (for filtering). */
export function statusesFor(labelKey) {
  return Object.keys(STATUS_TO_LABEL).filter((s) => STATUS_TO_LABEL[s] === labelKey);
}

/** Plain text, e.g. "🟡 Posted (partly)". */
export function statusText(status) {
  const st = libraryStatus(status);
  return `${st.dot} ${st.label}${st.note ? ` (${st.note})` : ''}`;
}

export default { LIBRARY_LABELS, NEEDS_YOU_STATUSES, libraryStatus, statusesFor, statusText };
