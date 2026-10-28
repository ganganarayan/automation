/**
 * Manual stepper: pure helpers.
 *
 * Purpose:      The settings-free rules for the in-app stage-by-stage runner —
 *               stage order, which stages take an editable input, and whether a
 *               stage can be executed yet (its predecessor is done). Kept apart
 *               so it unit-tests without a database.
 * Responsibility: Pure functions only.
 * Dependencies: none.
 */

/** The manual stages, in order (mirrors INSTANCE_STEPS keys; 'publish' = post). */
export const MANUAL_STAGES = ['script', 'images', 'animate', 'voiceover', 'transcript', 'stitch', 'publish'];

export const STAGE_LABEL = {
  script: 'Script', images: 'Images', animate: 'Image → video',
  voiceover: 'Voiceover', transcript: 'Transcript', stitch: 'Final reel', publish: 'Post',
};

/** Stages with an editable input box, and what that input is. */
export const INPUT_KIND = { script: 'script', images: 'prompts', animate: 'prompt', publish: 'caption' };

export function isEditable(key) {
  return Object.prototype.hasOwnProperty.call(INPUT_KIND, key);
}
export function inputKind(key) {
  return INPUT_KIND[key] || null;
}

export function prevKey(key) {
  const i = MANUAL_STAGES.indexOf(key);
  return i > 0 ? MANUAL_STAGES[i - 1] : null;
}
export function nextKey(key) {
  const i = MANUAL_STAGES.indexOf(key);
  return i >= 0 && i < MANUAL_STAGES.length - 1 ? MANUAL_STAGES[i + 1] : null;
}

function statusOf(steps, key) {
  const s = (Array.isArray(steps) ? steps : []).find((x) => x.key === key);
  return s ? s.status : 'pending';
}

/**
 * Can this stage be executed now? The first stage always; any later stage once
 * its predecessor is done. (A done stage stays executable, so it can be redone.)
 */
export function canExecute(steps, key) {
  if (!MANUAL_STAGES.includes(key)) return false;
  const prev = prevKey(key);
  if (!prev) return true;
  return statusOf(steps, prev) === 'done';
}

/** The next stage to run (first whose predecessor is done and itself not done). */
export function nextStage(steps) {
  for (const key of MANUAL_STAGES) {
    if (statusOf(steps, key) !== 'done' && canExecute(steps, key)) return key;
  }
  return null;
}

export default {
  MANUAL_STAGES, STAGE_LABEL, INPUT_KIND,
  isEditable, inputKind, prevKey, nextKey, canExecute, nextStage,
};
