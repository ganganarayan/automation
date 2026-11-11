/**
 * Text on a finished picture, put where the picture is empty.
 *
 * Purpose:      Pictures are drawn with no text. Claude looks at them once and
 *               marks, for each, the subject and the calm empty box; the app
 *               writes the words into that box. Used by Ready video thumbnails
 *               and by image posts.
 * Responsibility:
 *               - placeText({ claude, pictures, text, sub, tag, bottomClear, costs, log }): key -> checked box
 *               - drawText(buf, { text, sub, tag, place, accent }): the picture with the words on it (PNG)
 * Dependencies: sharp, thumbPlaceSpec, thumbSpec, pricing.
 */
import sharp from 'sharp';
import { PLACE_SCHEMA, placeSystem, placeUser, placeFor } from '../utils/thumbPlaceSpec.js';
import { thumbSvg, thumbSvgPlaced, textLayer, THUMB_ACCENT } from '../utils/thumbSpec.js';
import { costClaude } from '../utils/pricing.js';

/**
 * pictures: { key: { buf, w, h, label } }. One Claude call for all of them.
 * Returns key -> box; a key missing (no Claude, a failure, a box on the subject)
 * keeps the fixed layout. bottomClear: share of the height kept free (subtitles).
 */
export async function placeText({ claude, pictures, text, sub = '', tag = '', bottomClear = 0, costs = [], log }) {
  const entries = Object.entries(pictures || {});
  if (!claude || !entries.length || !String(text || '').trim()) return {};
  try {
    const items = await Promise.all(entries.map(async ([size, p]) => {
      const small = await sharp(p.buf).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
      return { size, label: p.label, w: p.w, h: p.h, b64: small.toString('base64') };
    }));
    const { data, model, usage } = await claude.generateJsonDetailed({ system: placeSystem({ bottomClear }), user: placeUser(items, { text, sub, tag }), schema: PLACE_SCHEMA, maxTokens: 8000 });
    costs.push({ step: 'images', ...costClaude({ ...usage, model }) });
    const out = {};
    for (const raw of (data && data.sizes) || []) {
      const p = pictures[raw && raw.size];
      const place = p ? placeFor(raw, { w: p.w, h: p.h, bottomClear }) : null;
      if (place) out[raw.size] = place;
      else if (p) log?.warn?.({ size: raw.size, raw }, 'text box refused (on the subject or too small), fixed layout used');
    }
    log?.info?.({ placed: Object.keys(out) }, 'text placed from the picture');
    return out;
  } catch (err) {
    log?.warn?.({ err: err.message }, 'text placement failed, fixed layout used');
    return {};
  }
}

/** Where the drawn letters really are: the bounding box of every visible pixel, or null. */
export async function inkBox(svg) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      if (data[row + x] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** How much the letters must shrink to stay in the box (1 = they fit). Pure. */
export function shrinkFor(ink, box, w, h) {
  if (!ink) return 1;
  const tol = Math.max(2, Math.round(Math.min(w, h) * 0.004));
  const left = Math.max(0, box.x0 - tol);
  const right = Math.min(w, box.x1 + tol);
  const bottom = Math.min(h, box.y1 + tol);
  const inside = ink.x0 >= left && ink.x1 <= right && ink.y0 >= Math.max(0, box.y0 - tol) && ink.y1 <= bottom;
  if (inside) return 1;
  const kw = (box.x1 - box.x0) / Math.max(1, ink.x1 - ink.x0);
  const kh = (box.y1 - box.y0) / Math.max(1, ink.y1 - ink.y0);
  return Math.max(0.3, Math.min(0.95, kw * 0.97, kh * 0.97));
}

/**
 * The text overlay for a picture, proven to fit: draw the letters alone with the
 * real fonts, measure where they landed, and shrink and redraw until they stay
 * inside their box (never wider than the box, never off the picture). Words are
 * never split: a long word makes the text smaller, not broken.
 */
export async function fittedOverlay({ w, h, text, sub = '', tag = '', accent = THUMB_ACCENT, place = null, layout = 'top' }) {
  let shrink = 1;
  for (let i = 0; i < 5; i += 1) {
    const { box, svg } = textLayer({ w, h, text, sub, tag, accent, place, layout, shrink });
    const k = shrinkFor(await inkBox(svg), box, w, h);
    if (k >= 1) break;
    shrink *= k;
  }
  return place
    ? thumbSvgPlaced({ w, h, text, sub, tag, accent, place, shrink })
    : thumbSvg({ w, h, text, sub, tag, accent, layout, shrink });
}

/** The words over a picture at its own size: in the box, else the fixed top layout. PNG. */
export async function drawText(buf, { text, sub = '', tag = '', place = null, accent = THUMB_ACCENT }) {
  const { width: w, height: h } = await sharp(buf).metadata();
  const svg = await fittedOverlay({ w, h, text, sub, tag, accent, place, layout: 'top' });
  return sharp(buf).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

export default { placeText, drawText, fittedOverlay, shrinkFor, inkBox };
