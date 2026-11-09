/**
 * Where the headline goes on each thumbnail, decided by looking at the picture
 * (pure: no I/O).
 *
 * Purpose:      The picture is drawn with no text. Claude then looks at each
 *               finished size and marks the calm empty area the headline can
 *               fill, plus where the faces and the main subject are. The app
 *               writes the text into that box, so the place changes with every
 *               picture and never lands on a face. A box that overlaps the
 *               subject, or is too small, is refused and the fixed layout is used.
 * Responsibility:
 *               - PLACE_SCHEMA, placeSystem(), placeUser(items, { text, sub, tag })
 *               - placeFor(raw, { w, h }): a checked box in pixels, or null
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

// The smallest box worth writing a headline into, as a share of the frame.
const MIN_W = 0.3;
const MIN_H = 0.14;
const EDGE = 0.03; // kept clear on every side
const MAX_OVERLAP = 0.06; // of the text box allowed on the subject

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

/**
 * The checked text box for one size, in pixels: { x0, y0, x1, y1, align, color },
 * or null when the model gave none, it is too small, or it sits on the subject.
 */
export function placeFor(raw, { w, h, bottomClear = 0 }) {
  if (!raw) return null;
  const box = toPx(raw.text, w, h);
  if (!box) return null;
  box.x0 = Math.max(box.x0, w * EDGE); box.y0 = Math.max(box.y0, h * EDGE);
  box.x1 = Math.min(box.x1, w * (1 - EDGE)); box.y1 = Math.min(box.y1, h * (1 - Math.max(EDGE, Math.min(0.5, Number(bottomClear) || 0))));
  if (box.x1 - box.x0 < w * MIN_W || box.y1 - box.y0 < h * MIN_H) return null;
  if (overlapShare(box, toPx(raw.subject, w, h)) > MAX_OVERLAP) return null;
  const align = ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
  const color = raw.color === 'dark' ? 'dark' : 'light';
  return { x0: Math.round(box.x0), y0: Math.round(box.y0), x1: Math.round(box.x1), y1: Math.round(box.y1), align, color };
}

export default { PLACE_SCHEMA, placeSystem, placeUser, placeFor, overlapShare };
