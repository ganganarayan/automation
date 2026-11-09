/**
 * Thumbnail sizes + the overlay design (pure: no I/O).
 *
 * Purpose:      One AI artwork per video (generated from an image prompt written
 *               from the transcript; a video frame if that fails), rendered in
 *               three sizes with the AI "thumbText" hook as the headline. Each
 *               platform uses the size that fits it. A platform without a
 *               thumbnail falls back to the video's first frame
 *               (thumbnail_timestamp_ms 0).
 * Responsibility:
 *               - THUMB_SIZES: size -> { w, h, label, layout }
 *               - PLATFORM_SIZE: platform -> size; THUMB_SPECS: platform -> its size spec
 *               - wrapText(text, maxChars, maxLines): lines
 *               - thumbBox / thumbArt: where the text and the artwork go
 *               - thumbSvg({ w, h, text, sub, layout, accent, tag }): SVG overlay string
 *                 (text = the headline, sub = an optional smaller sub-head, tag = the audience pill)
 *               - thumbTagClean / thumbTagFor: the audience call-out's rules and fallback
 *               - thumbTagBox: where the audience pill goes in each size
 *               - thumbImagePrompt(prompt, rules, headline, { asWritten }): the image-model prompt (rules = the Settings field)
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
export function thumbSvg({ w, h, text, sub = '', layout = 'top', accent = '#FFFFFF', tag = '' }) {
  const box = thumbBox({ w, h, layout });
  const stack = layout === 'stack';
  const maxSize = stack ? w * 0.085 : h * 0.11;
  const hazeH = stack ? thumbArt({ w, h, layout }).top : Math.round(h * 0.34);
  const stops = stack
    ? '<stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".3"/>'
    : '<stop offset="0" stop-color="#000" stop-opacity=".62"/><stop offset=".65" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs><rect width="${w}" height="${hazeH}" fill="url(#g)"/>
${textBlock({ box, text, sub, tag, accent, maxSize, align: 'center', color: 'light' })}</svg>`;
}

/**
 * The audience line (eyebrow) that sits above the headline: who the post is
 * for, up to 40 characters, no hashtags or emojis, no full stop at the end.
 * '' when unusable, never an error.
 */
export function eyebrowClean(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:!]+$/u, '').trim();
  if (!t || t.length > 40 || t.includes('#')) return '';
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/u.test(t)) return '';
  return t;
}

const SANS = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
const SERIF = 'font-family="Noto Serif, DejaVu Serif, serif"';

/**
 * The three lines as one block inside box: the audience eyebrow (small serif
 * italic capitals, accent colour), the headline (big bold sans) and the
 * sub-head under it, all fitted so no word is cut, aligned left, centre or
 * right, and centred in the box's height.
 */
export function textBlock({ box, text, sub = '', tag = '', accent = '#FFC400', maxSize, align = 'center', color = 'light' }) {
  const { x0, y0, x1, y1 } = box;
  const boxW = x1 - x0;
  const boxH = y1 - y0;
  const brow = eyebrowClean(tag).toUpperCase();
  const browShare = brow ? 0.16 : 0;
  const head = fitText(text, { boxW, boxH: boxH * ((sub ? 0.64 : 1) - browShare), maxSize, glyph: 0.62 });
  const size = head.size || Math.round(maxSize * 0.5);
  const lh = Math.round(size * 1.15);
  const subFit = fitText(sub, { boxW, boxH: boxH * 0.26, maxSize: size * 0.6, glyph: 0.56, lineH: 1.25 });
  const subLh = Math.round(subFit.size * 1.25);
  const subGap = subFit.lines.length ? Math.round(size * 0.2) : 0;
  const browSize = brow ? Math.max(10, Math.floor(Math.min(size * 0.42, boxW / (brow.length * 0.72)))) : 0;
  const browGap = brow ? Math.round(browSize * 0.55) : 0;
  const block = browSize + browGap + lh * head.lines.length + subGap + subLh * subFit.lines.length;
  const top = y0 + Math.max(0, (boxH - block) / 2);
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const x = align === 'left' ? x0 : align === 'right' ? x1 : Math.round((x0 + x1) / 2);
  const dark = color === 'dark';
  const fill = dark ? '#111111' : '#FFFFFF';
  const edge = dark ? '#FFFFFF' : '#000000';
  const stroke = (px) => `stroke="${edge}" stroke-width="${Math.max(2, Math.round(px * 0.06))}" paint-order="stroke"`;
  const parts = [];
  if (brow) {
    parts.push(`<text x="${x}" y="${Math.round(top + browSize * 0.85)}" text-anchor="${anchor}" ${SERIF} font-style="italic" font-weight="700" letter-spacing="${(browSize * 0.08).toFixed(1)}" font-size="${browSize}" fill="${dark ? '#9A6B00' : accent}" ${stroke(browSize)}>${xmlEsc(brow)}</text>`);
  }
  const hy0 = Math.round(top + browSize + browGap + size * 0.9);
  parts.push(`<text text-anchor="${anchor}" ${SANS} font-weight="800" font-size="${size}" fill="${fill}" ${stroke(size)}>${head.lines.map((l, i) => `<tspan x="${x}" y="${hy0 + i * lh}">${xmlEsc(l)}</tspan>`).join('')}</text>`);
  if (subFit.lines.length) {
    const sy0 = hy0 + (head.lines.length - 1) * lh + subGap + subLh;
    parts.push(`<text text-anchor="${anchor}" ${SANS} font-weight="700" font-size="${subFit.size}" fill="${dark ? '#111111' : '#FFFFFF'}" ${stroke(subFit.size)}>${subFit.lines.map((l, i) => `<tspan x="${x}" y="${sy0 + i * subLh}">${xmlEsc(l)}</tspan>`).join('')}</text>`);
  }
  return parts.join('\n');
}

/**
 * The audience call-out ("For founders"): 2 to 4 words, at most 24 characters,
 * no hashtags, no emojis, no punctuation at the end. Anything else comes back
 * '', never an error: a bad tag must not stop a thumbnail.
 */
export function thumbTagClean(raw) {
  const tag = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const words = tag.split(' ').filter(Boolean).length;
  if (words < 2 || words > 4 || tag.length > 24) return '';
  if (tag.includes('#')) return '';
  if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/u.test(tag)) return '';
  if (/[\p{P}\p{S}]$/u.test(tag)) return '';
  return tag;
}

/** The tag a thumbnail draws: the video's own, else the funnel's default, else none. Off = none. */
export function thumbTagFor({ on = true, tag = '', fallback = '' } = {}) {
  if (!on) return '';
  return thumbTagClean(tag) || thumbTagClean(fallback);
}

// Bold capitals run wider than the headline's mixed case; the text is centred, so a wide word eats padding evenly.
const TAG_GLYPH = 0.68;
const TAG_PAD = 0.45; // each side, in em

/**
 * Where the pill goes. Bottom-left of the picture: the frame in 16:9, the picture
 * panel in 9:16 and 4:5 (in 9:16 the frame's own bottom is a blurred strip that
 * Instagram's grid crops). It starts on the headline's 5% margin and never runs
 * past 55% of the width. The size is set by the width, not the headline's, so it
 * still reads at 160px wide: a long tag shrinks only as far as it must to fit.
 */
export function thumbTagBox({ w, h, layout = 'top', tag = '' }) {
  const label = String(tag).toUpperCase();
  const art = thumbArt({ w, h, layout });
  const x = Math.round(w * 0.05);
  const maxW = Math.round(w * 0.55) - x;
  const size = Math.floor(Math.min(art ? w / 30 : w / 32, maxW / (label.length * TAG_GLYPH + TAG_PAD * 2)));
  const pillW = Math.min(maxW, Math.round((label.length * TAG_GLYPH + TAG_PAD * 2) * size));
  const pillH = Math.round(size * 1.5);
  const bottom = (art ? art.top + art.h : h) - Math.round(h * 0.04);
  return { x, y: bottom - pillH, w: pillW, h: pillH, size, label };
}

/** The pill: solid accent, black bold capitals. */
function thumbTagSvg({ w, h, layout, tag }) {
  return pillSvg(thumbTagBox({ w, h, layout, tag }));
}

/**
 * The overlay with the text in a box picked from the picture (thumbPlaceSpec):
 * audience eyebrow, headline and sub-head stacked inside it, aligned as asked.
 * No haze: the box is already a calm part of the picture.
 */
export function thumbSvgPlaced({ w, h, text, sub = '', tag = '', accent = '#FFFFFF', place }) {
  const { align = 'center', color = 'light' } = place;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
${textBlock({ box: place, text, sub, tag, accent, maxSize: Math.min(w, h) * 0.13, align, color })}</svg>`;
}

/** A pill box from thumbTagBox, drawn: solid accent, black bold capitals. */
function pillSvg(b) {
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  const cx = Math.round(b.x + b.w / 2);
  const baseline = Math.round(b.y + b.h / 2 + b.size * 0.357); // half the cap height, so the capitals sit centred
  return `
<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.round(b.size * 0.2)}" fill="${THUMB_ACCENT}"/><text x="${cx}" y="${baseline}" text-anchor="middle" ${font} font-weight="800" font-size="${b.size}" fill="#000000">${xmlEsc(b.label)}</text>`;
}

/** The rules added after every image prompt. Editable under System prompts. */
export const DEFAULT_THUMB_RULES = 'Clear, bright, sharply lit marketing image in landscape format, understood in one second on a phone. Show exactly what is described above, and show it large: the main subject fills the frame below the top 30% and stays inside the centre 65% of the width, with nothing important cut off at the edges. Keep the top 30% of the frame a plain, uncluttered continuation of the background, because the headline goes there. No silhouettes, no dark moody scene, no dramatic shadows, and no person unless one is described. Text only where it belongs to something shown, such as the labels and numbers on a chart or screen described above: no headline, caption, logo or watermark.';

// The rules this replaced: a Settings page saved while still holding them is not a choice you made.
const OLD_THUMB_RULES = 'Thumbnail artwork, square composition. Show only what is described above: no person or face unless it asks for one. Place the main subject on the LEFT side of the frame (the left 55%), whole and well lit, with room around it. Keep the RIGHT 45% of the frame calm and empty: a plain dark wall, a soft out-of-focus background or sky, nothing important there, so a headline can sit on it. Bold cinematic lighting, high contrast, one clear focal subject. Absolutely no text, letters, words, captions, logos or watermarks.';

/** The longest image prompt kept: a Claude prompt must reach the image model whole. */
export const IMAGE_PROMPT_MAX = 4000;

/** All the app adds to a prompt Claude wrote: where its own headline and label go. */
export const THUMB_LAYOUT_ONLY = 'Landscape format. Leave one large calm empty area, where the description above puts it or else wherever suits the subject, with every face and the main subject fully outside it. Keep it truly empty: the app writes the headline and a small label there afterwards. No text, letters, numbers, captions, logos or watermarks anywhere in the image.';

/**
 * Image-model prompt for the thumbnail artwork. The app draws the headline; the
 * model is told it so the picture proves it. asWritten (Claude wrote the prompt):
 * the prompt goes as it is, with only the layout note, or rules you changed
 * yourself under System prompts; the built-in style rules would override it.
 */
export function thumbImagePrompt(prompt, rules = '', headline = '', { asWritten = false } = {}) {
  const subject = String(prompt || '').trim().slice(0, IMAGE_PROMPT_MAX) || 'A clear image of the exact thing the video is about';
  const saved = String(rules || '').trim();
  const head = String(headline || '').trim();
  if (asWritten) {
    const yours = saved && saved !== OLD_THUMB_RULES && saved !== DEFAULT_THUMB_RULES;
    return [subject, yours ? saved : THUMB_LAYOUT_ONLY].join('\n\n');
  }
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

export default { THUMB_ART_SIZE, THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbBox, thumbArt, thumbSvg, thumbTagClean, thumbTagFor, thumbTagBox, DEFAULT_THUMB_RULES, THUMB_LAYOUT_ONLY, IMAGE_PROMPT_MAX, thumbImagePrompt, thumbMedia };
