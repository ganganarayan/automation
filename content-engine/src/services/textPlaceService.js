/**
 * Text on a finished picture, put where the picture is empty, then checked.
 *
 * Purpose:      Pictures are drawn with no text. Claude looks at them once and
 *               marks, for each, the subject and the calm empty box; the app
 *               writes the words into that box. Claude then looks once at the
 *               finished picture: when text touches a face, the picture without
 *               text is read once more, keeping clear of the faces it found,
 *               and checked once more. Never more: at most four Claude calls,
 *               and the picture itself is never drawn again. Used by Ready video
 *               thumbnails and by image posts.
 * Responsibility:
 *               - placeChecked({ claude, pictures, text, sub, tag, bottomClear, costs, notes, log }):
 *                 key -> box, null (fixed layout) or { none: true } (no text on the picture);
 *                 anything not proven clear of faces gets a note (shown on the page)
 *               - placeText({ claude, pictures, text, ..., avoid, hints, last, raws }): one placement call
 *               - checkText({ claude, pictures, places, text, ... }): one look at the finished pictures
 *               - placeNoteText(notes): the notes as one line for the page
 *               - drawText(buf, { text, sub, tag, place, accent }): the picture with the words on it (PNG)
 * Dependencies: sharp, thumbPlaceSpec, thumbSpec, pricing.
 */
import sharp from 'sharp';
import { PLACE_SCHEMA, placeSystem, placeUser, placeFor, placeWhyNot, CHECK_SCHEMA, checkSystem, checkUser, checkFor, overlapShare } from '../utils/thumbPlaceSpec.js';
import { thumbSvg, thumbSvgPlaced, textLayer, THUMB_ACCENT } from '../utils/thumbSpec.js';
import { costClaude } from '../utils/pricing.js';

const small = async (buf) => (await sharp(buf).resize({ width: 768, height: 768, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64');

/**
 * One placement call. pictures: { key: { buf, w, h, label, layout? } }.
 * Returns key -> box; a key missing keeps the fixed top layout and gets a note
 * { size, label, reason } on `notes`. avoid: key -> pixel boxes the text must
 * not touch (faces found by the check); hints: key -> what the last try got
 * wrong; last: the final try (a smaller box rather than none); raws: filled
 * with the model's answer per key. bottomClear: share of the height kept free.
 */
export async function placeText({ claude, pictures, text, sub = '', tag = '', bottomClear = 0, costs = [], notes = [], log, avoid = {}, hints = {}, last = false, raws = {} }) {
  const entries = Object.entries(pictures || {});
  if (!entries.length || !String(text || '').trim()) return {};
  const note = (size, reason) => notes.push({ size, label: (pictures[size] && pictures[size].label) || size, reason });
  if (!claude) {
    for (const [size] of entries) note(size, 'no Claude key, so the text is in the fixed top band and was not checked for faces');
    return {};
  }
  try {
    const items = await Promise.all(entries.map(async ([size, p]) => ({ size, label: p.label, w: p.w, h: p.h, b64: await small(p.buf), hint: hints[size] || '' })));
    const { data, model, usage } = await claude.generateJsonDetailed({ system: placeSystem({ bottomClear }), user: placeUser(items, { text, sub, tag }), schema: PLACE_SCHEMA, maxTokens: 8000 });
    costs.push({ step: 'images', ...costClaude({ ...usage, model }) });
    const answers = new Map(((data && data.sizes) || []).filter((r) => r && pictures[r.size]).map((r) => [r.size, r]));
    const out = {};
    for (const [size, p] of entries) {
      const raw = answers.get(size) || null;
      raws[size] = raw;
      const place = placeFor(raw, { w: p.w, h: p.h, bottomClear, avoid: avoid[size] || [], last });
      if (place) {
        out[size] = place;
        if (place.how !== 'picked') log?.info?.({ size, how: place.how, raw }, 'text box moved off the subject');
      } else {
        note(size, `${placeWhyNot(raw, { w: p.w, h: p.h })}, so the text is in the fixed top band`);
        log?.warn?.({ size, raw }, 'no free text box, fixed layout used');
      }
    }
    log?.info?.({ placed: Object.keys(out), last }, 'text placed from the picture');
    return out;
  } catch (err) {
    // The call failed: on a last try the faces already found still give a place.
    const out = {};
    for (const [size, p] of entries) {
      const place = (avoid[size] || []).length ? placeFor(null, { w: p.w, h: p.h, bottomClear, avoid: avoid[size], last }) : null;
      if (place) out[size] = place;
      else note(size, `the placement call failed (${err.message}), so the text is in the fixed top band`);
    }
    log?.warn?.({ err: err.message }, 'text placement failed');
    return out;
  }
}

/**
 * One look at the finished pictures (the text drawn as it will be posted).
 * Returns key -> { ok, faces, problem }, or null when the call failed. ok is
 * false when Claude says the text touches a face, or when a face it marked
 * lies under the drawn letters (measured, not taken on trust).
 */
export async function checkText({ claude, pictures, places, text, sub = '', tag = '', accent = THUMB_ACCENT, costs = [], log }) {
  const entries = Object.entries(pictures || {});
  if (!claude || !entries.length) return null;
  try {
    const drawn = await Promise.all(entries.map(async ([size, p]) => {
      const svg = await fittedOverlay({ w: p.w, h: p.h, text, sub, tag, accent, place: places[size] || null, layout: p.layout || 'top' });
      const buf = await sharp(p.buf).resize(p.w, p.h, { fit: 'fill' }).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
      return { size, label: p.label, w: p.w, h: p.h, b64: await small(buf), ink: await inkBox(svg) };
    }));
    const { data, model, usage } = await claude.generateJsonDetailed({ system: checkSystem(), user: checkUser(drawn, { text }), schema: CHECK_SCHEMA, maxTokens: 4000 });
    costs.push({ step: 'images', ...costClaude({ ...usage, model }) });
    const answers = new Map(((data && data.sizes) || []).filter((r) => r && pictures[r.size]).map((r) => [r.size, r]));
    const out = {};
    for (const d of drawn) {
      const seen = checkFor(answers.get(d.size), { w: d.w, h: d.h }) || { ok: false, faces: [], problem: 'the check gave no answer for this size' };
      // Any real overlap with a (padded) head counts: 10% let text across a forehead pass.
      const under = d.ink ? seen.faces.some((f) => overlapShare(f, d.ink) > 0.02) : false;
      out[d.size] = { ok: seen.ok && !under, faces: seen.faces, problem: seen.problem || (under ? 'a face lies under the text' : '') };
    }
    log?.info?.({ check: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.ok])) }, 'finished text checked');
    return out;
  } catch (err) {
    log?.warn?.({ err: err.message }, 'text check failed');
    return null;
  }
}

/**
 * Place, draw, check; when text touches a face, place once more (the picture
 * without text, read again, keeping clear of every face found) and check once
 * more. Then stop: a size still failing is moved clear of every face either
 * check found, with no further AI call, or gets no text at all when no space
 * is clear. Returns key -> box, null (fixed top layout) or { none: true }.
 * Every size not proven clear gets a note on `notes`, for the page.
 */
export async function placeChecked({ claude, pictures, text, sub = '', tag = '', bottomClear = 0, accent = THUMB_ACCENT, costs = [], notes = [], log, hint = '' }) {
  const entries = Object.entries(pictures || {});
  if (!entries.length || !String(text || '').trim()) return {};
  const note = (size, reason) => notes.push({ size, label: (pictures[size] && pictures[size].label) || size, reason });
  // The reviewer's own correction (e.g. "text off her face, put it at the bottom") goes to every placement.
  const asked = String(hint || '').trim().slice(0, 400);
  const told = asked ? Object.fromEntries(entries.map(([size]) => [size, `The reviewer asked: ${asked}`])) : {};
  const first = [];
  const places = await placeText({ claude, pictures, text, sub, tag, bottomClear, costs, notes: first, log, hints: told });
  if (!claude) { notes.push(...first); return places; }
  const look1 = await checkText({ claude, pictures, places, text, sub, tag, accent, costs, log });
  if (!look1) {
    notes.push(...first);
    for (const [size] of entries) if (!first.some((n) => n.size === size)) note(size, 'the check after drawing failed, so this one was not checked for faces');
    return places;
  }
  const bad = entries.filter(([size]) => !look1[size].ok).map(([size]) => size);
  if (!bad.length) return places;

  // The one more try, for the sizes that failed only.
  const again = Object.fromEntries(bad.map((size) => [size, pictures[size]]));
  const avoid = Object.fromEntries(bad.map((size) => [size, look1[size].faces]));
  const hints = Object.fromEntries(bad.map((size) => [size, `the text placed last time covered ${look1[size].problem || 'a face'}. Pick an area well away from every face, head and body.${asked ? ` The reviewer asked: ${asked}` : ''}`]));
  const raws = {};
  const second = [];
  const retry = await placeText({ claude, pictures: again, text, sub, tag, bottomClear, costs, notes: second, log, avoid, hints, last: true, raws });
  for (const size of bad) places[size] = retry[size] || (look1[size].faces.length ? { none: true } : null);
  const shown = Object.fromEntries(bad.filter((size) => !(places[size] && places[size].none)).map((size) => [size, pictures[size]]));
  const look2 = Object.keys(shown).length ? await checkText({ claude, pictures: shown, places, text, sub, tag, accent, costs, log }) : {};
  for (const size of bad) {
    const p = pictures[size];
    if (places[size] && places[size].none) { note(size, `no space clear of the faces after a second try, so the picture has no text on it (${look1[size].problem || 'text on a face'})`); continue; }
    if (!look2) { note(size, 'moved off a face on the second try, but the second check failed, so it was not checked again'); continue; }
    if (look2[size] && look2[size].ok) { log?.info?.({ size }, 'text fixed on the second try'); continue; }
    // Stop here: no third call. Clear of every face either look found, or no text.
    const faces = [...look1[size].faces, ...((look2[size] && look2[size].faces) || [])];
    const place = placeFor(raws[size] || null, { w: p.w, h: p.h, bottomClear, avoid: faces, last: true });
    places[size] = place || { none: true };
    note(size, place
      ? `still on a face after the second try (${(look2[size] && look2[size].problem) || 'text on a face'}), moved clear of every face found, not checked a third time`
      : `still on a face after the second try, and no space is clear of the faces, so the picture has no text on it`);
  }
  log?.warn?.({ sizes: bad, notes: notes.length }, 'text over a face on the first try, placed again');
  return places;
}

/** The notes from placeChecked as one line for the page; '' when every size is clear. */
export function placeNoteText(notes = []) {
  if (!notes.length) return '';
  const parts = notes.map((n) => `${n.label}: ${n.reason}`);
  return `Check the text on these thumbnails. ${[...new Set(parts)].join('; ')}`;
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
  if (place && place.none) return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`;
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

/** The words over a picture at its own size: in the box, else the fixed top layout; none = no words. PNG. */
export async function drawText(buf, { text, sub = '', tag = '', place = null, accent = THUMB_ACCENT }) {
  const { width: w, height: h } = await sharp(buf).metadata();
  const svg = await fittedOverlay({ w, h, text, sub, tag, accent, place, layout: 'top' });
  return sharp(buf).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

export default { placeChecked, placeText, checkText, placeNoteText, drawText, fittedOverlay, shrinkFor, inkBox };
