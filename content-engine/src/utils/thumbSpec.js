/**
 * Thumbnail sizes + the overlay design (pure — no I/O).
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
 *               - thumbSvg({ w, h, text, layout, accent }): SVG overlay string
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
 * The overlay drawn on the frame: a darkening gradient behind the text and the
 * hook as big bold white text with a black outline (no accent bar).
 */
export function thumbSvg({ w, h, text, layout = 'center', accent = '#FFFFFF' }) {
  const portrait = h > w;
  const lines = wrapText(text, portrait ? 12 : 16, 3);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  // ~0.7em per glyph for heavy bold fonts keeps the longest line inside 84% of the width.
  const size = Math.round(Math.min(portrait ? w * 0.12 : h * 0.14, (w * 0.84) / (longest * 0.7)));
  const lh = Math.round(size * 1.15);
  const block = lh * lines.length;
  const anchor = layout === 'left' || layout === 'top' ? 'start' : 'middle';
  const x = anchor === 'start' ? Math.round(w * 0.06) : Math.round(w / 2);
  const top = {
    left: (h - block) / 2,
    top: h * 0.08,
    bottom: h * 0.92 - block,
    upper: h * 0.22,
    center: (h - block) / 2,
  }[layout] ?? (h - block) / 2;
  const y0 = Math.round(top + size);
  // Gradient band behind the text so it reads on any frame.
  const band = layout === 'left'
    ? `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".8"/><stop offset=".75" stop-color="#000" stop-opacity="0"/></linearGradient><rect width="${w}" height="${h}" fill="url(#g)"/>`
    : `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".5" stop-color="#000" stop-opacity=".75"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient><rect y="${Math.round(top - lh * 0.6)}" width="${w}" height="${Math.round(block + lh * 1.2)}" fill="url(#g)"/>`;
  const tspans = lines
    .map((l, i) => `<tspan x="${x}" y="${y0 + i * lh}">${xmlEsc(l)}</tspan>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${band.split('<rect')[0]}</defs><rect${band.split('<rect')[1]}
<text text-anchor="${anchor}" font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif" font-weight="800" font-size="${size}" fill="#FFFFFF" stroke="#000000" stroke-width="${Math.max(2, Math.round(size * 0.06))}" paint-order="stroke">${tspans}</text></svg>`;
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

export default { THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, thumbSvg, thumbImagePrompt, thumbMedia };
