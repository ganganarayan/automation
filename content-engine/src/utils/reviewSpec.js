/**
 * Instance review (checkpoint) spec — pure helpers.
 *
 * Purpose:      The settings-free pieces of the two-checkpoint review flow: which
 *               checkpoints exist, the status transition on approve / reject,
 *               correction-note validation, round bumping, and the Google-Drive
 *               embed / thumbnail URL builders used by the in-email player and the
 *               review page. Kept apart from the service so they unit-test without
 *               a database (like utils/instanceSpec, utils/videoSchedule).
 * Responsibility: Pure functions only.
 * Dependencies: none.
 *
 * Locked decisions: two checkpoints — (1) script review, then the stages auto-run
 * (slice 5), then (2) final review; approve final => post + lock. Every reject
 * carries a correction note => rework on the SAME instance_id, new round.
 */

/** The two review checkpoints. stepKey is the instance step whose artifact the
 *  checkpoint shows; approveStatus is the instance status after approval. */
export const CHECKPOINTS = {
  script: { key: 'script', label: 'Script review', stepKey: 'script', approveStatus: 'running' },
  final: { key: 'final', label: 'Final review', stepKey: 'stitch', approveStatus: 'posted' },
};

/** Whether a string names a known checkpoint. */
export function isCheckpoint(c) {
  return c === 'script' || c === 'final';
}

/** The status + lock to set when a checkpoint is APPROVED. */
export function approveTransition(checkpoint) {
  if (checkpoint === 'script') return { status: 'running', lock: false };
  if (checkpoint === 'final') return { status: 'posted', lock: true };
  throw new Error(`unknown checkpoint: ${checkpoint}`);
}

/**
 * The status to return to when a checkpoint is REJECTED (correction => rework).
 * script reject => regenerate the script (back to script_review).
 * final reject  => regenerate downstream from the correction (back to running).
 */
export function rejectTransition(checkpoint) {
  if (checkpoint === 'script') return { status: 'script_review' };
  if (checkpoint === 'final') return { status: 'running' };
  throw new Error(`unknown checkpoint: ${checkpoint}`);
}

/** Trim a correction note to a plain string ('' when missing/blank). */
export function normalizeNote(note) {
  return String(note ?? '').trim();
}

/** Every reject must carry a non-empty correction note (locked decision). */
export function isValidCorrection(note) {
  return normalizeNote(note).length > 0;
}

/** The next rework round (1-based; defaults a missing/invalid round to 1). */
export function nextRound(round) {
  const n = Number(round);
  return (Number.isFinite(n) && n > 0 ? n : 1) + 1;
}

// ---- Google-Drive embed URLs (match modules/instances.js DRV / THB) --------

/** The Drive /preview embed URL (the in-browser / in-email player target). */
export function driveEmbedUrl(id) {
  return `https://drive.google.com/file/d/${encodeURIComponent(String(id || ''))}/preview`;
}

/** The Drive thumbnail URL (the email poster image). */
export function driveThumbUrl(id, size = 'w600') {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(String(id || ''))}&sz=${encodeURIComponent(size)}`;
}

export default {
  CHECKPOINTS,
  isCheckpoint,
  approveTransition,
  rejectTransition,
  normalizeNote,
  isValidCorrection,
  nextRound,
  driveEmbedUrl,
  driveThumbUrl,
};
