/**
 * Move the text (pure).
 *
 * Purpose:      Review's Move the text places the words again on the same
 *               picture; it never draws a new one. That works only for a post
 *               that kept its picture without text: an image post made from a
 *               video's own still, or a sheet image post that kept its no-text
 *               pictures and their words (images.artifacts.bare / words).
 * Responsibility: canMoveText(steps).
 * Dependencies: none.
 */

const imagesArt = (steps) => ((Array.isArray(steps) ? steps : []).find((s) => s && s.key === 'images') || {}).artifacts || {};

/** True when the text can be placed again on the same picture. */
export function canMoveText(steps) {
  const img = imagesArt(steps);
  if (img.stepDown) return true;
  const bare = img.bare && typeof img.bare === 'object' ? img.bare : {};
  return Object.keys(bare).length > 0 && !!String((img.words && img.words.headline) || '').trim();
}

export default { canMoveText };
