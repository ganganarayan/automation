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
 *               - freeParts(rect, blocks, { w, h }): the parts of rect clear of every block
 *               - CHECK_SCHEMA, checkSystem(), checkUser(items, { text }): the look at the
 *                 finished thumbnail (text on a face?), and checkFor(raw, { w, h }) its answer in pixels
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
// The last try only: a smaller box (smaller letters) beats text on a face.
const LAST_W = 0.12;
const LAST_H = 0.08;
const EDGE = 0.03; // kept clear on every side
const MAX_OVERLAP = 0.06; // of the text box allowed on the subject
const GAP = 0.015; // kept between the subject and text moved off it

export function placeSystem({ bottomClear = 0 } = {}) {
  const keep = Math.round(Math.max(0, Math.min(0.5, Number(bottomClear) || 0)) * 100);
  return [
    'You place the headline on finished social media thumbnails. Each image has no text yet.',
    'For each image, return:',
    '- subject: one box around the main person\'s face and head (hair included) and the main subject (the product), in percent of that image (x, y = top-left corner; w, h = size; 0 to 100). Keep it tight: not the whole frame.',
    '- text: the largest calm, empty area for a bold headline of the length given, in percent, completely outside the subject box: plain background, sky, wall, floor or soft blur. Prefer a wide box; it may run along any side. Keep 3% clear of every edge.',
    '- align: left, center or right, whichever sits best in that area next to the subject.',
    '- color: light (white text) when the area is dark, dark (near-black text) when it is bright.',
    'Never put the text box over a face, head, eyes, hands or the main subject, even partly. Prefer an area that is off people\'s bodies too (wall, table, background, blur); use a body only when nothing else is free. The top is not special: when the faces are at the top, use the bottom, a side or any other empty area. Judge each size on its own picture: they are cropped differently.',
    keep ? `The bottom ${keep}% of every image is kept for subtitles: the text box must end above it.` : '',
  ].filter(Boolean).join('\n');
}

/** items: [{ size, label, w, h, b64, hint? }] (JPEG base64; hint = what the last try got wrong). Returns the user content blocks. */
export function placeUser(items, { text = '', sub = '', tag = '' } = {}) {
  const words = [
    `Headline: "${String(text).trim()}"`,
    sub ? `Sub-head under it: "${String(sub).trim()}"` : '',
    tag ? `A small label under those: "${String(tag).trim()}"` : '',
  ].filter(Boolean).join('\n');
  const blocks = [{ type: 'text', text: `${words}\n\nReturn one entry per image, in this order, with its size name.` }];
  for (const it of items) {
    blocks.push({ type: 'text', text: `Image "${it.size}" (${it.label}, ${it.w}x${it.h}):${it.hint ? `\nNote: ${it.hint}` : ''}` });
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
const touches = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

/**
 * The parts of rect that touch none of the blocks (with a small gap): each block
 * splits every part it touches into the pieces left of, right of, above and
 * below it. Parts too small to matter are dropped as it goes. Pure.
 */
export function freeParts(rect, blocks, { w, h, minW = 0, minH = 0 }) {
  const gx = w * GAP; const gy = h * GAP;
  let parts = [rect];
  for (const s of blocks.filter(Boolean)) {
    const next = [];
    for (const b of parts) {
      if (!touches(b, { x0: s.x0 - gx, y0: s.y0 - gy, x1: s.x1 + gx, y1: s.y1 + gy })) { next.push(b); continue; }
      next.push({ ...b, x1: Math.min(b.x1, s.x0 - gx) }, { ...b, x0: Math.max(b.x0, s.x1 + gx) }, { ...b, y1: Math.min(b.y1, s.y0 - gy) }, { ...b, y0: Math.max(b.y0, s.y1 + gy) });
    }
    parts = next.filter((b) => b.x1 - b.x0 >= minW && b.y1 - b.y0 >= minH).slice(0, 400);
  }
  return parts;
}

const largest = (parts) => parts.sort((a, b) => areaOf(b) - areaOf(a))[0] || null;

/**
 * The checked text box for one size, in pixels: { x0, y0, x1, y1, align, color, how },
 * how = 'picked' (the model's box as it was), 'trimmed' (cut back off the
 * subject) or 'beside' (the widest free strip next to the subject, when the
 * model's own box was unusable). avoid: more boxes in pixels the text must not
 * touch at all (faces the check found on the last try). last: the final try,
 * which also takes a smaller box rather than none. null when nothing is free:
 * the caller must then say so.
 */
export function placeFor(raw, { w, h, bottomClear = 0, avoid = [], last = false }) {
  const away = (avoid || []).filter(Boolean);
  if (!raw && !away.length) return null;
  const frame = frameFor(w, h, bottomClear);
  const subject = raw ? toPx(raw.subject, w, h) : null;
  const blocks = [subject, ...away].filter(Boolean);
  const picked = raw ? toPx(raw.text, w, h) : null;
  const clear = (b) => overlapShare(b, subject) <= MAX_OVERLAP && away.every((a) => !touches(b, a));
  let box = null;
  let how = '';
  for (const [mw, mh] of last ? [[MIN_W, MIN_H], [LAST_W, LAST_H]] : [[MIN_W, MIN_H]]) {
    const minW = w * mw; const minH = h * mh;
    const big = (b) => b.x1 - b.x0 >= minW && b.y1 - b.y0 >= minH;
    if (picked && big(clip(picked, frame)) && clear(clip(picked, frame))) { box = clip(picked, frame); how = 'picked'; break; }
    if (picked && blocks.length) {
      box = largest(freeParts(clip(picked, frame), blocks, { w, h, minW, minH }));
      if (box) { how = 'trimmed'; break; }
    }
    if (blocks.length) {
      box = largest(freeParts(frame, blocks, { w, h, minW, minH }));
      if (box) { how = 'beside'; break; }
    }
  }
  if (!box) return null;
  const align = raw && ['left', 'center', 'right'].includes(raw.align) ? raw.align : 'center';
  const color = raw && raw.color === 'dark' ? 'dark' : 'light';
  return { x0: Math.round(box.x0), y0: Math.round(box.y0), x1: Math.round(box.x1), y1: Math.round(box.y1), align, color, how };
}

/** Why placeFor gave null for this answer, in plain words for the page. */
export function placeWhyNot(raw, { w, h }) {
  if (!raw) return 'the AI returned no text box for this size';
  if (!toPx(raw.subject, w, h)) return 'the AI did not mark the subject, so no free area could be checked';
  return 'the subject fills the picture: no free area is big enough for the headline';
}

// The look at the finished thumbnail: is any text on a face?
export const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    sizes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          size: { type: 'string' },
          ok: { type: 'boolean' },
          faces: { type: 'array', items: pctBox },
          problem: { type: 'string' },
        },
        required: ['size', 'ok', 'faces', 'problem'],
        additionalProperties: false,
      },
    },
  },
  required: ['sizes'],
  additionalProperties: false,
};

export function checkSystem() {
  return [
    'You check finished social media thumbnails before they are posted. The app wrote text on each picture.',
    'For each image, return:',
    '- faces: one box around every face and whole head, hair included, in the picture (people and animals), in percent of that image (x, y = top-left corner; w, h = size; 0 to 100). An empty list when there are none.',
    '- ok: true only when no letter of the text covers or touches any face, forehead, hair, eyes, mouth or head. Text over a hand, an arm, clothing, a table, a wall, sky or blur is fine.',
    '- problem: when ok is false, say in a few words what the text covers; else an empty string.',
    'Judge each image on its own.',
  ].join('\n');
}

/** items: [{ size, label, w, h, b64 }] finished thumbnails (JPEG base64). */
export function checkUser(items, { text = '' } = {}) {
  const blocks = [{ type: 'text', text: `The headline written on them: "${String(text).trim()}"\n\nReturn one entry per image, in this order, with its size name.` }];
  for (const it of items) {
    blocks.push({ type: 'text', text: `Image "${it.size}" (${it.label}, ${it.w}x${it.h}):` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: it.b64 } });
  }
  return blocks;
}

/** One size's check answer: { ok, faces: [pixel boxes], problem }; null when unusable. */
/** A face box grown 25% of its height on top and 10% on the other sides, kept in the frame. */
export function padFace(b, { w, h }) {
  const fw = b.x1 - b.x0;
  const fh = b.y1 - b.y0;
  return {
    x0: Math.max(0, Math.round(b.x0 - fw * 0.1)), x1: Math.min(w, Math.round(b.x1 + fw * 0.1)),
    y0: Math.max(0, Math.round(b.y0 - fh * 0.25)), y1: Math.min(h, Math.round(b.y1 + fh * 0.1)),
  };
}

export function checkFor(raw, { w, h }) {
  if (!raw || typeof raw.ok !== 'boolean') return null;
  // Padded: a box drawn round the face often stops at the eyebrows, so text on
  // the hairline or forehead slipped through. A quarter more on top, a tenth round the rest.
  const faces = (Array.isArray(raw.faces) ? raw.faces : []).map((b) => toPx(b, w, h)).filter((b) => b && areaOf(b) > 0).map((b) => padFace(b, { w, h }));
  return { ok: raw.ok, faces, problem: String(raw.problem || '').slice(0, 200) };
}

export default { PLACE_SCHEMA, placeSystem, placeUser, placeFor, placeWhyNot, overlapShare, freeParts, CHECK_SCHEMA, checkSystem, checkUser, checkFor };
