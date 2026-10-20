/**
 * Images-selectable gate: pure helpers.
 *
 * Purpose:      Deterministic pieces of the image gate — image sizing, count
 *               clamping, default scene-prompt building, file naming, and the
 *               keep-selection math — split from the service so they unit-test
 *               without pulling in settings/logger (like utils/animationSpec).
 * Responsibility: Pure functions only.
 * Dependencies: none.
 */

/** Funnel image_size -> an OpenAI image size (portrait is the reel default). */
export function mapImageSize(imageSize) {
  return String(imageSize || '').toLowerCase() === 'square' ? '1024x1024' : '1024x1536';
}

/** Parse a configured count into an integer in [1, 12], with a fallback. */
export function clampCount(value, fallback = 4) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 12);
}

/** Build `count` non-empty scene prompts from an optional style and topic. */
export function defaultScenePrompts({ count = 4, style = '', topic = '' } = {}) {
  const n = clampCount(count, 4);
  const base = [String(topic || '').trim(), String(style || '').trim()].filter(Boolean).join('. ');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push([base, `scene ${i + 1} of ${n}`].filter(Boolean).join(', '));
  }
  return out;
}

/** A safe, unique-ish PNG name for an uploaded still. */
export function buildImageName(prefix, index, stamp) {
  const safe = String(prefix || 'img').replace(/[^a-z0-9_-]+/gi, '-');
  return `${safe}-${stamp}-${index}.png`;
}

/**
 * The kept images: those whose id is in keepIds. An empty/omitted keepIds means
 * keep everything (the review page checks every box by default).
 */
export function selectKept(images, keepIds) {
  const list = Array.isArray(images) ? images : [];
  if (!Array.isArray(keepIds) || keepIds.length === 0) return list.slice();
  const set = new Set(keepIds.map(String));
  return list.filter((img) => set.has(String(img.id)));
}

/** Split images into { keep, regen } by a set of ids to regenerate. */
export function partitionByRegen(images, regenIds) {
  const list = Array.isArray(images) ? images : [];
  const set = new Set((Array.isArray(regenIds) ? regenIds : []).map(String));
  const keep = [];
  const regen = [];
  for (const img of list) (set.has(String(img.id)) ? regen : keep).push(img);
  return { keep, regen };
}

export default { mapImageSize, clampCount, defaultScenePrompts, buildImageName, selectKept, partitionByRegen };
