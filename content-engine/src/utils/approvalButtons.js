/**
 * Library approval buttons (pure).
 *
 * Purpose:      Approve from the app, not only from the email. Every instance
 *               waiting on the user's approval gets two buttons on the Library:
 *               Review (see the script, or the reel at the final checkpoint,
 *               and edit + Save the copy) and Approve (exactly what the email's
 *               link does). These are the settings-free pieces: which instances
 *               show the buttons, their labels, the editable fields per kind,
 *               and how a saved edit patches the instance and the approval.
 * Responsibility: Pure functions only. No I/O.
 * Dependencies: none.
 *
 * Kinds (approvalService.onKind): instance_review (AI lane, checkpoint script
 * or final), ready_video (router lane 1), image_post (router lane 3). Each
 * stores payload.instanceId.
 */

/** Approval kind → the instance status it waits at (per checkpoint for instance_review). */
const WAIT_STATUS = {
  instance_review: { script: 'script_review', final: 'final_review' },
  ready_video: 'video_review',
  image_post: 'image_review',
};

/** The instance statuses that mean "waiting on the user's approval". */
export const APPROVAL_WAIT_STATUSES = ['script_review', 'final_review', 'video_review', 'image_review'];

/** The instance status an approval row waits at ('' for a kind the Library does not handle). */
export function waitStatusOf(approval) {
  const a = approval || {};
  const w = WAIT_STATUS[a.kind];
  if (!w) return '';
  if (typeof w === 'string') return w;
  return w[(a.payload || {}).checkpoint] || '';
}

/** True when an approval row can still be acted on (pending, link not used). */
export function isOpen(approval) {
  return !!approval && approval.status === 'pending' && !approval.token_used;
}

/**
 * The newest open approval per instance id.
 * @param {object[]} rows - approvals rows ({ id, kind, payload, status, token_used, created_at })
 * @returns {Map<string, object>}
 */
export function pendingByInstance(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const id = r && r.payload && r.payload.instanceId != null ? String(r.payload.instanceId) : '';
    if (!id || !isOpen(r)) continue;
    const prev = out.get(id);
    if (!prev || new Date(r.created_at || 0) > new Date(prev.created_at || 0)) out.set(id, r);
  }
  return out;
}

/** What the Review screen shows for an approval: the script, the reel, the copy or the image. */
export function reviewView(approval) {
  const a = approval || {};
  if (a.kind === 'instance_review') return (a.payload || {}).checkpoint === 'final' ? 'video' : 'script';
  if (a.kind === 'ready_video') return 'copy';
  if (a.kind === 'image_post') return 'image';
  return '';
}

/**
 * The buttons for one Library row, or null when it shows none: the instance
 * must wait at the status its open approval belongs to, it must not be locked
 * or busy posting, and the viewer must be allowed to approve.
 * @param {object} instance - instances row
 * @param {object|null} approval - its open approval (pendingByInstance)
 * @param {{ canApprove?: boolean, videoId?: string }} [opts]
 * @returns {null | { reviewHref: string, approveUrl: string, approveLabel: string, view: string, videoId: string }}
 */
export function approvalButtons(instance, approval, { canApprove = false, videoId = '' } = {}) {
  const r = instance || {};
  if (!canApprove || !r.id || r.locked) return null;
  if (!APPROVAL_WAIT_STATUSES.includes(r.status)) return null;
  if (String(r.post_status || '').startsWith('post')) return null;
  if (!isOpen(approval) || String((approval.payload || {}).instanceId) !== String(r.id)) return null;
  if (waitStatusOf(approval) !== r.status) return null;
  const view = reviewView(approval);
  const base = `/api/v1/admin/instances/${encodeURIComponent(r.id)}`;
  return {
    reviewHref: `${base}/review`,
    approveUrl: `${base}/approve`,
    approveLabel: view === 'script' ? 'Approve script' : 'Approve & post',
    view,
    // The final checkpoint's Review plays the reel straight away.
    videoId: view === 'video' ? String(videoId || (approval.payload || {}).videoId || '') : '',
  };
}

/**
 * The editable fields on the Review screen for an approval, filled from the
 * instance's script step artifacts (falling back to the approval payload).
 * The final checkpoint has none: the reel is already made.
 * @returns {{ key: string, label: string, value: string, rows: number }[]}
 */
export function reviewFields(approval, scriptArtifacts = {}) {
  const p = (approval || {}).payload || {};
  const s = scriptArtifacts || {};
  const copy = s.copy || {};
  const view = reviewView(approval);
  if (view === 'script') return [{ key: 'text', label: 'Script', value: String(s.text ?? p.scriptText ?? ''), rows: 14 }];
  if (view === 'copy') {
    return [
      { key: 'title', label: 'Title', value: String(copy.title ?? ''), rows: 2 },
      { key: 'description', label: 'Description', value: String(copy.description ?? p.caption ?? ''), rows: 10 },
    ];
  }
  if (view === 'image') {
    return [
      { key: 'captionFull', label: 'Full caption', value: String(s.captionFull ?? p.captionFull ?? ''), rows: 10 },
      { key: 'captionShort', label: 'Short caption', value: String(s.captionShort ?? p.captionShort ?? ''), rows: 4 },
    ];
  }
  return [];
}

/**
 * A saved edit → the patch for the script step artifacts and for the approval
 * payload, so the approve handlers (which read the instance) and the email's
 * review page (which reads the payload) both see it. Unknown keys are ignored;
 * a field left out keeps its current value. Returns null when nothing is
 * editable for this approval.
 * @returns {null | { artifacts: object, payload: object }}
 */
export function applyReviewEdit(approval, scriptArtifacts = {}, body = {}) {
  const fields = reviewFields(approval, scriptArtifacts);
  if (!fields.length) return null;
  const b = body || {};
  const val = {};
  for (const f of fields) val[f.key] = b[f.key] != null ? String(b[f.key]).replace(/\r\n/g, '\n').trim() : f.value;
  const p = (approval || {}).payload || {};
  const s = scriptArtifacts || {};
  const view = reviewView(approval);
  if (view === 'script') {
    return { artifacts: { text: val.text }, payload: { ...p, scriptText: val.text } };
  }
  if (view === 'copy') {
    const copy = { ...(s.copy || {}), title: val.title, description: val.description };
    return { artifacts: { copy }, payload: { ...p, caption: [val.title, val.description].filter(Boolean).join('\n\n') } };
  }
  // image: the lane posts captionShort || captionFull and logs copy.description.
  const copy = { ...(s.copy || {}), description: val.captionFull };
  return {
    artifacts: { captionFull: val.captionFull, captionShort: val.captionShort, text: val.captionShort || val.captionFull, copy },
    payload: { ...p, captionFull: val.captionFull, captionShort: val.captionShort },
  };
}

export default { APPROVAL_WAIT_STATUSES, waitStatusOf, isOpen, pendingByInstance, reviewView, approvalButtons, reviewFields, applyReviewEdit };
