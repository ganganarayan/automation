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
import { thumbSvg, thumbSvgPlaced, THUMB_ACCENT } from '../utils/thumbSpec.js';
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

/** The words over a picture at its own size: in the box, else the fixed top layout. PNG. */
export async function drawText(buf, { text, sub = '', tag = '', place = null, accent = THUMB_ACCENT }) {
  const { width: w, height: h } = await sharp(buf).metadata();
  const svg = place
    ? thumbSvgPlaced({ w, h, text, sub, tag, accent, place })
    : thumbSvg({ w, h, text, sub, tag, accent, layout: 'top' });
  return sharp(buf).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

export default { placeText, drawText };
