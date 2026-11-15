/**
 * Where the headline goes on each thumbnail, decided by looking at the picture
 * (pure: no I/O).
 *
 * Purpose:      The picture is drawn with no text. Claude then looks at each
 *               finished size and marks the calm empty area the headline can
 *               fill, plus where the faces and the main subject are. The app
 *               writes the text into that box, so the place changes with every
 *               picture and never lands on a face. A box that overlaps the
 *               subject is trimmed off it, else moved into the widest free strip
 *               beside the subject; only when no strip is big enough is it
 *               refused (and the caller must say so on the page).
 * Responsibility:
 *               - PLACE_SCHEMA, placeSystem(), placeUser(items, { text, sub, tag })
 *               - placeFor(raw, { w, h }): a checked box in pixels (with how it was found), or null
 *               - placeWhyNot(raw, { w, h }): why placeFor gave null, in words
 *               - overlapShare(a, b): how much of box a lies on box b
 * Dependencies: none.
 */

const pctBox = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
};

export const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    sizes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          size: { type: 'string' },
          subject: pctBox,
          text: pctBox,
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          color: { type: 'string', enum: ['light', 'dark'] },
        },
        required: ['size', 'subject', 'text', 'align', 'color'],
        additionalProperties: false,
      },
    },
  },
  required: ['sizes'],
  additionalProperties: false,
};

// The smallest box worth writing a headline into, as a share of the frame. A
// narrow box wraps the headline onto more lines; it never puts it on a face.
const MIN_W = 0.22;
const MIN_H = 0.14;
const EDGE = 0.03; // kept clear on every side
const MAX_OVERLAP = 0.06; // of the text box allowed on the subject
const GAP = 0.015; // kept between the subject and text moved off it

export function placeSystem({ bottomClear = 0 } = {}) {
  const keep = Math.round(Math.max(0, Math.min(0.5, Number(bottomClear) || 0)) * 100);
  return [
    'You place the headline on finished social media thumbnails. Each image has no text yet.',
    'For each image, return:',
    '- subject: one box around every face and the main subject together (heads, hands, the product), in percent of that image (x, y = top-left corner; w, h = size; 0 to 100).',
    '- text: the largest calm, empty area for a bold headline of the length given, in percent, completely outside the subject box: plain background, sky, wall, floor or soft blur. Prefer a wide box; it may run along any side. Keep 3% clear of every edge.',
    '- align: left, center or right, whichever sits best in that area next to the subject.',
    '- color: light (white text) when the area is dark, dark (near-black text) when it is bright.',
    'Never put the text box over a face, eyes, hands or the main subject, even partly. Judge each size on its own picture: they are cropped differently.',
    keep ? `The bottom ${keep}% of every image is kept for subtitles: the text box must end above it.` : '',
  ].filter(Boolean).join('\n');
}

/** items: [{ size, label, w, h, b64 }] (JPEG base64). Returns the user content blocks. */
export function placeUser(items, { text = '', sub = '', tag = '' } = {}) {
  const words = [
    `Headline: "${String(text).trim()}"`,
    sub ? `Sub-head under it: "${String(sub).trim()}"` : '',
    tag ? `A small label under those: "${String(tag).trim()}"` : '',
  ].filter(Boolean).join('\n');
  const blocks = [{ type: 'text', text: `${words}\n\nReturn one entry per image, in this order, with its size name.` }];
  for (const it of items) {
    blocks.push({ type: 'text', text: `Image "${it.size}" (${it.label}, ${it.w}x${it.h}):` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: it.b64 } });
  }
  return blocks;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** A percent box from the model as pixels, clamped inside the frame; null when unusable. */
function toPx(b, w, h) {
  if (!b) return null;
  let x = num(b.x); let y = num(b.y); let bw = num(b.w); let bh = num(b.h);
  if ([x, y, bw, bh].some(Number.isNaN)) return null;
  x = Math.max(0, Math.min(100, x)); y = Math.max(0, Math.min(100, y));
  bw = Math.max(0, Math.min(100 - x, bw)); bh = Math.max(0, Math.min(100 - y, bh));
  return { x0: (x / 100) * w, y0: (y / 100) * h, x1: ((x + bw) / 100) * w, y1: ((y + bh) / 100) * h };
}

/** Share of box a (0 to 1) that lies on box b. */
export function overlapShare(a, b) {
  const area = (a.x1 - a.x0) * (a.y1 - a.y0);
  if (!(area > 0) || !b) return 0;
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return (ix * iy) / area;
}

const areaOf = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/** The part of the frame text may use: the edges and the subtitle band left clear. */
function frameFor(w, h, bottomClear) {
  return { x0: w * EDGE, y0: h * EDGE, x1: w * (1 - EDGE), y1: h * (1 - Math.max(EDGE, Math.min(0.5, Number(bottomClear) || 0))) };
}

const clip = (b, f) => ({ x0: Math.max(b.x0, f.x0), y0: Math.max(b.y0, f.y0), x1: Math.min(b.x1, f.x1), y1: Math.min(b.y1, f.y1) });

/** The four parts of box b that lie fully left of, right of, above and below the subject. */
function sidesOff(b, s, w, h) {
  const gx = w * GAP; const gy = h * GAP;
  return [
    { ...b, x1: Math.min(b.x1, s.x0 - gx) },
    { ...b, x0: Math.max(b.x0, s.x1 + gx) },
    { ...b, y1: Math.min(b.y1, s.y0 - gy) },
    { ...b, y0: Math.max(b.y0, s.y1 + gy) },
  ];
}

/**
 * The checked text box for one size, in pixels: { x0, y0, x1, y1, align, color, how },
 * how = 'picked' (the model's box as it was), 'trimmed' (cut back off the
 * subject) or 'beside' (the widest free strip next to the subject, when the
 * model's own box was unusable). null when the model gave nothing usable and no
 * strip beside the subject is big enough: the caller must then say so.
 */
export function placeFor(raw, { w, h, bottomClear = 0 }) {
  if (!raw) return null;
  const frame = frameFor(w, h, bottomClear);
  const subject = toPx(raw.subject, w, h);
  const big = (b) => b.x1 - b.x0 >= w * MIN_W && b.y1 - b.y0 >= h * MIN_H;
  const clear = (b) => overlapShare(b, subject) <= MAX_OVERLAP;
  const fits = (b) => big(b) && clear(b);
  const picked = toPx(raw.text, w, h);
  let box = null;
  let how = '';
  if (picked && fits(clip(picked, frame))) { box = clip(picked, frame); how = 'picked'; }
  if (!box && picked && subject) {
    const trims = sidesOff(clip(picked, frame), subject, w, h).filter(fits).sort((a, b) => areaOf(b) - areaOf(a));
    if (trims.length) { box = trims[0]; how = 'trimmed'; }
  }
  if (!box && subject) {
    const strips = sidesOff(frame, subject, w, h).filter(fits).sort((a, b) => areaOf(b) - areaOf(a));
    if (strips.length) { box = strips[0]; how = 'beside'; }
  }
  if (!box) return null;
  const align = ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
  const color = raw.color === 'dark' ? 'dark' : 'light';
  return { x0: Math.round(box.x0), y0: Math.round(box.y0), x1: Math.round(box.x1), y1: Math.round(box.y1), align, color, how };
}

/** Why placeFor gave null for this answer, in plain words for the page. */
export function placeWhyNot(raw, { w, h }) {
  if (!raw) return 'the AI returned no text box for this size';
  if (!toPx(raw.subject, w, h)) return 'the AI did not mark the subject, so no free area could be checked';
  return 'the subject fills the picture: no free area is big enough for the headline';
}

export default { PLACE_SCHEMA, placeSystem, placeUser, placeFor, placeWhyNot, overlapShare };
