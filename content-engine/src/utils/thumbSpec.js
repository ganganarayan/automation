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
 *               - thumbSvg({ w, h, text, sub, layout, accent }): SVG overlay string
 *                 (text = the headline, sub = an optional smaller sub-head)
 *               - thumbImagePrompt(prompt): the image-model prompt
 *               - thumbMedia(videoUrl, thumbUrl): Post for Me media item
 * Dependencies: none.
 */

export const THUMB_ACCENT = '#FFC400';

/** The three sizes every video gets, all from the same artwork. */
export const THUMB_SIZES = {
  landscape: { w: 1280, h: 720, label: '16:9', layout: 'bottom' },
  portrait: { w: 1080, h: 1920, label: '9:16', layout: 'upper' },
  feed: { w: 1080, h: 1350, label: '4:5', layout: 'bottom' },
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
    if (!best || size > best.size) best = { lines, size };
  }
  return best;
}

/**
 * The overlay drawn on the frame: a darkening gradient behind the text, the
 * hook as big bold white text with a black outline (the whole headline, sized
 * to fit, never cut), and the sub-head as dark text on a solid accent box so
 * it reads on any picture.
 */
export function thumbSvg({ w, h, text, sub = '', layout = 'center', accent = '#FFFFFF' }) {
  const portrait = h > w;
  const head = fitText(text, { boxW: w * 0.88, boxH: h * (portrait ? 0.3 : 0.42), maxSize: portrait ? w * 0.12 : h * 0.15, glyph: 0.64 });
  const lines = head.lines;
  const size = head.size || Math.round(h * 0.1);
  const lh = Math.round(size * 1.15);
  // Sub-head: smaller, under the headline, on its own solid box.
  const subFit = fitText(sub, { boxW: w * 0.82, boxH: h * (portrait ? 0.12 : 0.18), maxSize: size * 0.5, glyph: 0.58, lineH: 1.25 });
  const subLines = subFit.lines;
  const subSize = subFit.size;
  const subLh = Math.round(subSize * 1.25);
  const pad = Math.round(subSize * 0.45);
  const subGap = subLines.length ? Math.round(size * 0.4) : 0;
  const subBlock = subLines.length ? subLh * subLines.length + pad * 2 : 0;
  const block = lh * lines.length + subGap + subBlock;
  const anchor = layout === 'left' || layout === 'top' ? 'start' : 'middle';
  const x = anchor === 'start' ? Math.round(w * 0.06) : Math.round(w / 2);
  const top = {
    left: (h - block) / 2,
    top: h * 0.06,
    bottom: h * 0.94 - block,
    upper: h * 0.2,
    center: (h - block) / 2,
  }[layout] ?? (h - block) / 2;
  const y0 = Math.round(top + size * 0.9);
  // Gradient band behind the text so it reads on any frame.
  const band = layout === 'left'
    ? `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".85"/><stop offset=".75" stop-color="#000" stop-opacity="0"/></linearGradient><rect width="${w}" height="${h}" fill="url(#g)"/>`
    : `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".2" stop-color="#000" stop-opacity=".8"/><stop offset=".8" stop-color="#000" stop-opacity=".8"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient><rect y="${Math.round(top - lh * 0.5)}" width="${w}" height="${Math.round(block + lh)}" fill="url(#g)"/>`;
  const tspans = lines
    .map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${xmlEsc(l)}</tspan>`)
    .join('');
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  let subText = '';
  if (subLines.length) {
    const boxTop = y0 + (lines.length - 1) * lh + Math.round(size * 0.3) + subGap;
    const longest = Math.max(...subLines.map((l) => l.length));
    const boxW = Math.min(w * 0.92, Math.round(longest * subSize * 0.58 + pad * 3));
    const boxX = anchor === 'start' ? x - pad : Math.round((w - boxW) / 2);
    const subY0 = boxTop + pad + Math.round(subSize * 0.95);
    const subSpans = subLines
      .map((l, i) => `<tspan x="${x}" y="${subY0 + i * subLh}">${xmlEsc(l)}</tspan>`)
      .join('');
    subText = `
<rect x="${boxX}" y="${boxTop}" width="${boxW}" height="${subBlock}" rx="${Math.round(subSize * 0.3)}" fill="${accent}"/>
<text text-anchor="${anchor}" ${font} font-weight="700" font-size="${subSize}" fill="#111111">${subSpans}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${band.split('<rect')[0]}</defs><rect${band.split('<rect')[1]}
<text text-anchor="${anchor}" ${font} font-weight="800" font-size="${size}" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(2, Math.round(size * 0.06))}" paint-order="stroke">${tspans}</text>${subText}</svg>`;
}

/** Image-model prompt for the thumbnail artwork (text is drawn by the app, never by the model). */
export function thumbImagePrompt(prompt) {
  const subject = String(prompt || '').trim().slice(0, 1500) || 'A striking, emotive scene that matches the video topic';
  return `${subject}\n\nThumbnail artwork, square composition with the focal subject centred so it can be cropped wide or tall. Bold cinematic lighting, high contrast, vivid colours, one clear focal subject, clean empty space for a headline. Absolutely no text, letters, words, captions, logos or watermarks.`;
}

/** The Post for Me media item: a designed thumbnail, else the first frame. */
export function thumbMedia(videoUrl, thumbUrl) {
  return thumbUrl ? { url: videoUrl, thumbnail_url: thumbUrl } : { url: videoUrl, thumbnail_timestamp_ms: 0 };
}

export default { THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbSvg, thumbImagePrompt, thumbMedia };
