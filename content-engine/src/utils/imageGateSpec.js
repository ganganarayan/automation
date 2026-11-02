/**
 * Images-selectable gate: pure helpers.
 *
 * Purpose:      Deterministic pieces of the image gate, image sizing, count
 *               clamping, default scene-prompt building, file naming, and the
 *               keep-selection math: split from the service so they unit-test
 *               without pulling in settings/logger (like utils/animationSpec).
 * Responsibility: Pure functions only.
 * Dependencies: none.
 */

/**
 * Funnel image_size choices: the OpenAI size to generate at (OpenAI makes
 * only 1024x1024, 1024x1536, 1536x1024) and the aspect to crop to after.
 */
export const IMAGE_SIZES = {
  square: { size: '1024x1024', aspect: null },
  portrait: { size: '1024x1536', aspect: null },
  story: { size: '1024x1536', aspect: '9:16' },
  landscape: { size: '1536x1024', aspect: '16:9' },
};

/** Funnel image_size -> { size, aspect } (unknown -> the fallback choice). */
export function imageSpec(imageSize, fallback = 'portrait') {
  return IMAGE_SIZES[String(imageSize || '').toLowerCase()] || IMAGE_SIZES[fallback];
}

/** Funnel image_size -> an OpenAI image size (portrait is the reel default). */
export function mapImageSize(imageSize) {
  return imageSpec(imageSize).size;
}

/**
 * The centred crop box that turns a width x height image into the aspect
 * ('9:16', '16:9'), or null when it already fits (or no aspect is asked).
 */
export function cropBox(width, height, aspect) {
  const m = /^(\d+):(\d+)$/.exec(String(aspect || ''));
  if (!m || !width || !height) return null;
  const target = Number(m[1]) / Number(m[2]);
  if (Math.abs(width / height - target) < 0.01) return null;
  if (width / height > target) {
    const w = Math.round(height * target);
    return { left: Math.floor((width - w) / 2), top: 0, width: w, height };
  }
  const h = Math.round(width / target);
  return { left: 0, top: Math.floor((height - h) / 2), width, height: h };
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
