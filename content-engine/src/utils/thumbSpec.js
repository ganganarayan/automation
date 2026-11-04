/**
 * Thumbnail sizes + the overlay design (pure: no I/O).
 *
 * Purpose:      One AI artwork per video (generated from an image prompt written
 *               from the transcript; a video frame if that fails), rendered in
 *               three sizes with the AI "thumbText" hook as the headline. Each
 *               platform uses the size that fits it. A platform without a
 *               thumbnail falls back to the video's first frame
 *               (thumbnail_timestamp_ms 0). A funnel with a content sheet skips
 *               all of this: each size is its own image from the next Ready row
 *               (postCompose.sheetThumbPrompt), with the row's words on it.
 * Responsibility:
 *               - THUMB_SIZES: size -> { w, h, label, layout }
 *               - PLATFORM_SIZE: platform -> size; THUMB_SPECS: platform -> its size spec
 *               - wrapText(text, maxChars, maxLines): lines
 *               - thumbBox / thumbArt: where the text and the artwork go
 *               - thumbSvg({ w, h, text, sub, layout, accent }): SVG overlay string
 *                 (text = the headline, sub = an optional smaller sub-head)
 *               - thumbImagePrompt(prompt, rules, headline): the image-model prompt (rules = the Settings field)
 *               - thumbMedia(videoUrl, thumbUrl): Post for Me media item
 * Dependencies: none.
 */

export const THUMB_ACCENT = '#FFC400';

/** The artwork's size. Landscape, because most platforms post 16:9 and a square loses too much to the crop. */
export const THUMB_ART_SIZE = '1536x1024';

/** The three sizes every video gets, all from the same artwork. */
export const THUMB_SIZES = {
  landscape: { w: 1280, h: 720, label: '16:9', layout: 'top' },
  portrait: { w: 1080, h: 1920, label: '9:16', layout: 'stack' },
  feed: { w: 1080, h: 1350, label: '4:5', layout: 'stack' },
};

/** Which size each platform posts with. */
export const PLATFORM_SIZE = {
  youtube: 'landscape',
  facebook: 'landscape',
  linkedin: 'landscape',
  x: 'landscape',
  instagram: 'portrait',
  threads: 'feed',
};

export const THUMB_SPECS = Object.fromEntries(
  Object.entries(PLATFORM_SIZE).map(([k, size]) => [k, { ...THUMB_SIZES[size], size, accent: THUMB_ACCENT }]),
);

/** Greedy word wrap into at most `maxLines` lines of ~`maxChars` (last line clipped). */
export function wrapText(text, maxChars = 18, maxLines = 3) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * Wrap `text` into the fewest lines that give the biggest font while every
 * word fits: never clipped. `maxSize` caps the font, `boxW` x `boxH` is the
 * area the block may fill, `glyph` the average glyph width in em.
 */
export function fitText(text, { boxW, boxH, maxSize, glyph = 0.62, lineH = 1.15 }) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size: 0 };
  const longestWord = Math.max(...words.map((x) => x.length));
  const total = words.join(' ').length;
  let best = null;
  for (let chars = longestWord; chars <= Math.max(longestWord, total); chars += 1) {
    const lines = wrapText(text, chars, 99);
    const longest = Math.max(...lines.map((l) => l.length));
    const size = Math.floor(Math.min(maxSize, boxW / (longest * glyph), boxH / (lines.length * lineH)));
    if (!best || size >= best.size) best = { lines, size }; // a tie keeps the wider wrap (fewer lines)
  }
  return best;
}

/**
 * Where the text goes: always a centred block in the top 30% of the frame, so
 * the picture keeps the rest. 'top': over the full-frame picture. 'stack' (9:16
 * and 4:5, too narrow to fill with a landscape picture): above the picture
 * panel; 9:16 stays inside the centre 3:4 that Instagram's grid shows.
 * Returns the text box in pixels.
 */
export function thumbBox({ w, h, layout = 'top' }) {
  const box = (y0, y1) => ({ x0: Math.round(w * 0.05), x1: Math.round(w * 0.95), y0: Math.round(y0), y1: Math.round(y1), anchor: 'middle' });
  if (layout === 'stack') {
    const art = thumbArt({ w, h, layout });
    return box(h > w * 1.5 ? h * 0.14 : h * 0.03, art.top - h * 0.01);
  }
  return box(h * 0.04, h * 0.28);
}

/** The 'stack' layout's picture panel, full width under the text (null for 'top'). */
export function thumbArt({ w, h, layout = 'top' }) {
  if (layout !== 'stack') return null;
  const tall = h > w * 1.5;
  const top = Math.round(h * (tall ? 0.3 : 0.28));
  return { top, w, h: (tall ? Math.round(h * 0.8) : h) - top };
}

/**
 * The overlay drawn on the frame: a haze that fades out over the top of the
 * picture (never a solid patch), the whole headline in bold white with a black
 * outline, sized to fit and never cut, and the sub-head under it in the accent
 * colour.
 */
export function thumbSvg({ w, h, text, sub = '', layout = 'top', accent = '#FFFFFF' }) {
  const box = thumbBox({ w, h, layout });
  const boxW = box.x1 - box.x0;
  const boxH = box.y1 - box.y0;
  const stack = layout === 'stack';
  const maxSize = stack ? w * 0.085 : h * 0.11;
  const head = fitText(text, { boxW, boxH: boxH * (sub ? 0.66 : 1), maxSize, glyph: 0.62 });
  const lines = head.lines;
  const size = head.size || Math.round(maxSize * 0.6);
  const lh = Math.round(size * 1.15);
  const subFit = fitText(sub, { boxW, boxH: boxH * 0.3, maxSize: size * 0.6, glyph: 0.56, lineH: 1.25 });
  const subLines = subFit.lines;
  const subSize = subFit.size;
  const subLh = Math.round(subSize * 1.25);
  const subGap = subLines.length ? Math.round(size * 0.2) : 0;
  const block = lh * lines.length + subGap + subLh * subLines.length;
  const x = Math.round((box.x0 + box.x1) / 2);
  const top = box.y0 + Math.max(0, (boxH - block) / 2);
  const y0 = Math.round(top + size * 0.9);
  const hazeH = stack ? thumbArt({ w, h, layout }).top : Math.round(h * 0.34);
  const stops = stack
    ? '<stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".3"/>'
    : '<stop offset="0" stop-color="#000" stop-opacity=".62"/><stop offset=".65" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/>';
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  const stroke = (px) => `stroke="#000000" stroke-width="${Math.max(2, Math.round(px * 0.06))}" paint-order="stroke"`;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${xmlEsc(l)}</tspan>`).join('');
  const subY0 = y0 + (lines.length - 1) * lh + subGap + subLh;
  const subSpans = subLines.map((l, i) => `<tspan x="${x}" y="${subY0 + i * subLh}">${xmlEsc(l)}</tspan>`).join('');
  const subText = subLines.length ? `
<text text-anchor="middle" ${font} font-weight="700" font-size="${subSize}" fill="${accent}" ${stroke(subSize)}>${subSpans}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs><rect width="${w}" height="${hazeH}" fill="url(#g)"/>
<text text-anchor="middle" ${font} font-weight="800" font-size="${size}" fill="#FFFFFF" ${stroke(size)}>${tspans}</text>${subText}</svg>`;
}

/** The image size to ask for, for a thumbnail made at its own shape. */
export function nativeArtSize({ w, h }) {
  return w > h ? '1536x1024' : '1024x1536';
}

/** The rules added after every image prompt. Editable under System prompts. */
export const DEFAULT_THUMB_RULES = 'Clear, bright, sharply lit marketing image in landscape format, understood in one second on a phone. Show exactly what is described above, and show it large: the main subject fills the frame below the top 30% and stays inside the centre 65% of the width, with nothing important cut off at the edges. Keep the top 30% of the frame a plain, uncluttered continuation of the background, because the headline goes there. No silhouettes, no dark moody scene, no dramatic shadows, and no person unless one is described. Text only where it belongs to something shown, such as the labels and numbers on a chart or screen described above: no headline, caption, logo or watermark.';

// The rules this replaced: a Settings page saved while still holding them is not a choice you made.
const OLD_THUMB_RULES = 'Thumbnail artwork, square composition. Show only what is described above: no person or face unless it asks for one. Place the main subject on the LEFT side of the frame (the left 55%), whole and well lit, with room around it. Keep the RIGHT 45% of the frame calm and empty: a plain dark wall, a soft out-of-focus background or sky, nothing important there, so a headline can sit on it. Bold cinematic lighting, high contrast, one clear focal subject. Absolutely no text, letters, words, captions, logos or watermarks.';

/** Image-model prompt for the thumbnail artwork. The app draws the headline; the model is told it so the picture proves it. */
export function thumbImagePrompt(prompt, rules = '', headline = '') {
  const subject = String(prompt || '').trim().slice(0, 1500) || 'A clear image of the exact thing the video is about';
  const saved = String(rules || '').trim();
  const head = String(headline || '').trim();
  return [
    subject,
    head ? `The headline going over this image is "${head}". The picture must make that headline obvious at a glance. Do not write the headline in the image.` : '',
    saved && saved !== OLD_THUMB_RULES ? saved : DEFAULT_THUMB_RULES,
  ].filter(Boolean).join('\n\n');
}

/** The Post for Me media item: a designed thumbnail, else the first frame. */
export function thumbMedia(videoUrl, thumbUrl) {
  return thumbUrl ? { url: videoUrl, thumbnail_url: thumbUrl } : { url: videoUrl, thumbnail_timestamp_ms: 0 };
}

export default { THUMB_ART_SIZE, nativeArtSize, THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbBox, thumbArt, thumbSvg, DEFAULT_THUMB_RULES, thumbImagePrompt, thumbMedia };
