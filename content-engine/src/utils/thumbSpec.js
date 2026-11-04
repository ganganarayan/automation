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
 *               - thumbBox / thumbArt / pickTextSide: where the text and the artwork go
 *               - thumbSvg({ w, h, text, sub, layout, side, accent }): SVG overlay string
 *                 (text = the headline, sub = an optional smaller sub-head)
 *               - thumbImagePrompt(prompt, rules): the image-model prompt (rules = the Settings field)
 *               - thumbMedia(videoUrl, thumbUrl): Post for Me media item
 * Dependencies: none.
 */

export const THUMB_ACCENT = '#FFC400';

/** The three sizes every video gets, all from the same artwork. */
export const THUMB_SIZES = {
  landscape: { w: 1280, h: 720, label: '16:9', layout: 'side' },
  portrait: { w: 1080, h: 1920, label: '9:16', layout: 'stack' },
  feed: { w: 1080, h: 1350, label: '4:5', layout: 'side' },
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
 * Where the text goes. 'side': a column on the calm side of the picture (the
 * subject keeps the other side, face uncovered). 'stack' (9:16): the artwork
 * sits whole as a square panel and the text gets its own band above it, inside
 * the centre 3:4 that Instagram's grid shows. Returns the text box in pixels.
 */
export function thumbBox({ w, h, layout = 'side', side = 'right' }) {
  if (layout === 'stack') {
    const art = thumbArt({ w, h, layout });
    return { x0: Math.round(w * 0.07), x1: Math.round(w * 0.93), y0: Math.round(h * 0.14), y1: art.top - Math.round(h * 0.015), anchor: 'middle' };
  }
  const col = Math.round(w * (h > w * 1.1 ? 0.44 : 0.42));
  const m = Math.round(w * 0.04);
  const x0 = side === 'left' ? m : w - col;
  return { x0, x1: side === 'left' ? col : w - m, y0: Math.round(h * 0.08), y1: Math.round(h * 0.92), anchor: 'start' };
}

/** The 'stack' layout's artwork panel: a full-width square under the text band (null for 'side'). */
export function thumbArt({ w, h, layout = 'side' }) {
  if (layout !== 'stack') return null;
  return { top: Math.round(h * 0.34), size: w };
}

/**
 * The calmer side takes the text: right unless the left is clearly emptier.
 * `grey` is a row-major greyscale image (one byte a pixel); busy = the pixel
 * spread (standard deviation) of its outer thirds.
 */
export function pickTextSide(grey, width, height) {
  const third = Math.floor(width / 3);
  const spread = (x0) => {
    let n = 0; let sum = 0; let sq = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = x0; x < x0 + third; x += 1) { const v = grey[y * width + x]; n += 1; sum += v; sq += v * v; }
    }
    return n ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : 0;
  };
  return spread(width - third) <= spread(0) * 1.15 + 1 ? 'right' : 'left';
}

/**
 * The overlay drawn on the frame: a darkening gradient on the text side only,
 * the hook as bold white text with a black outline at a moderate size (the
 * whole headline, sized to fit, never cut), and the sub-head as dark text on a
 * solid accent box so it reads on any picture. The subject's side stays clear.
 */
export function thumbSvg({ w, h, text, sub = '', layout = 'side', side = 'right', accent = '#FFFFFF' }) {
  const box = thumbBox({ w, h, layout, side });
  const boxW = box.x1 - box.x0;
  const boxH = box.y1 - box.y0;
  const stack = layout === 'stack';
  const maxSize = stack ? w * 0.08 : Math.min(h * 0.085, w * 0.06);
  const head = fitText(text, { boxW, boxH: boxH * (sub ? 0.68 : 1), maxSize, glyph: 0.68 });
  const lines = head.lines;
  const size = head.size || Math.round(maxSize * 0.6);
  const lh = Math.round(size * 1.15);
  // Sub-head: smaller, under the headline, on its own solid box.
  const subFit = fitText(sub, { boxW: boxW * 0.9, boxH: boxH * 0.28, maxSize: size * 0.55, glyph: 0.58, lineH: 1.25 });
  const subLines = subFit.lines;
  const subSize = subFit.size;
  const subLh = Math.round(subSize * 1.25);
  const pad = Math.round(subSize * 0.45);
  const subGap = subLines.length ? Math.round(size * 0.45) : 0;
  const subBlock = subLines.length ? subLh * subLines.length + pad * 2 : 0;
  const block = lh * lines.length + subGap + subBlock;
  const anchor = box.anchor;
  const x = anchor === 'start' ? box.x0 + pad : Math.round((box.x0 + box.x1) / 2);
  const top = box.y0 + Math.max(0, (boxH - block) / 2);
  const y0 = Math.round(top + size * 0.9);
  // Shade only where the text is, fading out before the subject's side.
  let band;
  if (stack) {
    const bandTop = box.y0 - Math.round(h * 0.03);
    band = `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".15" stop-color="#000" stop-opacity=".6"/><stop offset="1" stop-color="#000" stop-opacity=".75"/></linearGradient><rect y="${bandTop}" width="${w}" height="${box.y1 - bandTop}" fill="url(#g)"/>`;
  } else {
    const fade = Math.round(w * (h > w ? 0.07 : 0.12));
    const [from, to] = side === 'left' ? [0, box.x1 + fade] : [box.x0 - fade, w];
    const stops = side === 'left'
      ? '<stop offset="0" stop-color="#000" stop-opacity=".88"/><stop offset=".8" stop-color="#000" stop-opacity=".78"/><stop offset="1" stop-color="#000" stop-opacity="0"/>'
      : '<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".2" stop-color="#000" stop-opacity=".78"/><stop offset="1" stop-color="#000" stop-opacity=".88"/>';
    band = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient><rect x="${from}" width="${to - from}" height="${h}" fill="url(#g)"/>`;
  }
  const tspans = lines
    .map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${xmlEsc(l)}</tspan>`)
    .join('');
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  let subText = '';
  if (subLines.length) {
    const boxTop = y0 + (lines.length - 1) * lh + Math.round(size * 0.3) + subGap;
    const longest = Math.max(...subLines.map((l) => l.length));
    const subW = Math.min(boxW + pad, Math.round(longest * subSize * 0.58 + pad * 3));
    const boxX = anchor === 'start' ? x - pad : Math.round(x - subW / 2);
    const subY0 = boxTop + pad + Math.round(subSize * 0.95);
    const subSpans = subLines
      .map((l, i) => `<tspan x="${x}" y="${subY0 + i * subLh}">${xmlEsc(l)}</tspan>`)
      .join('');
    subText = `
<rect x="${boxX}" y="${boxTop}" width="${subW}" height="${subBlock}" rx="${Math.round(subSize * 0.3)}" fill="${accent}"/>
<text text-anchor="${anchor}" ${font} font-weight="700" font-size="${subSize}" fill="#111111">${subSpans}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${band.split('<rect')[0]}</defs><rect${band.split('<rect')[1]}
<text text-anchor="${anchor}" ${font} font-weight="800" font-size="${size}" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(2, Math.round(size * 0.06))}" paint-order="stroke">${tspans}</text>${subText}</svg>`;
}

/** The rules added after every image prompt. Editable under System prompts. */
export const DEFAULT_THUMB_RULES = 'Thumbnail artwork, square composition. Show only what is described above: no person or face unless it asks for one. Place the main subject on the LEFT side of the frame (the left 55%), whole and well lit, with room around it. Keep the RIGHT 45% of the frame calm and empty: a plain dark wall, a soft out-of-focus background or sky, nothing important there, so a headline can sit on it. Bold cinematic lighting, high contrast, one clear focal subject. Absolutely no text, letters, words, captions, logos or watermarks.';

/** Image-model prompt for the thumbnail artwork (text is drawn by the app, never by the model). */
export function thumbImagePrompt(prompt, rules = '') {
  const subject = String(prompt || '').trim().slice(0, 1500) || 'A striking scene that matches the video topic';
  return `${subject}\n\n${String(rules || '').trim() || DEFAULT_THUMB_RULES}`;
}

/** The Post for Me media item: a designed thumbnail, else the first frame. */
export function thumbMedia(videoUrl, thumbUrl) {
  return thumbUrl ? { url: videoUrl, thumbnail_url: thumbUrl } : { url: videoUrl, thumbnail_timestamp_ms: 0 };
}

export default { THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbBox, thumbArt, pickTextSide, thumbSvg, DEFAULT_THUMB_RULES, thumbImagePrompt, thumbMedia };
