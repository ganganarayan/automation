/**
 * On-video call to action per channel (pure: no I/O).
 *
 * Purpose:      A short line such as "Subscribe for more like this" shown for a
 *               few seconds in the middle of a video, worded for each channel
 *               (Subscribe on YouTube, Follow or DM elsewhere). Each channel has
 *               up to five lines typed in Settings; every video takes the next
 *               line in turn, so they rotate. No AI.
 * Responsibility:
 *               - CTA_PLATFORMS, DEFAULT_CTA: channels and their built-in lines
 *               - ctaLines(text, platform): the typed lines, else the defaults
 *               - normalizeVideoCta(raw): { on, sec, lists }
 *               - ctaPlan({ platforms, lists, turn }): platform -> line
 *               - ctaWindow(durationSec, sec): when it shows (middle of the video)
 *               - ctaBannerSvg({ w, h, text, platform }): the overlay picture
 *               - ctaOverlayArgs(...): ffmpeg args burning it in for that window
 *               - videoPlatforms(configs, videoUrl): which channels post this video
 *               - withCtaVideos(configs, videoUrl, urlByPlatform): configs with
 *                 each channel's own copy swapped in (thumbnails kept)
 * Dependencies: none.
 */

export const CTA_PLATFORMS = ['youtube', 'instagram', 'facebook', 'tiktok', 'linkedin', 'threads', 'x'];

const FOLLOW = ['Follow for more like this', 'DM us for the details', 'Follow so you never miss one'];

/** Built-in lines. Channels sharing a line at the same turn share one render. */
export const DEFAULT_CTA = {
  youtube: ['Subscribe for more like this', 'Hit Subscribe so you never miss one', 'Enjoying this? Subscribe'],
  instagram: FOLLOW,
  facebook: ['Follow our page for more', 'Message us for the details', 'Follow so you never miss one'],
  tiktok: FOLLOW,
  linkedin: FOLLOW,
  threads: FOLLOW,
  x: FOLLOW,
};

export const CTA_MAX_LINES = 5;
export const CTA_MAX_CHARS = 60;
export const CTA_SEC_OPTIONS = [3, 4, 5, 6, 8];

/** The lines typed for a channel (one per line, up to five), else its defaults. */
export function ctaLines(text, platform) {
  const typed = String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, CTA_MAX_CHARS))
    .filter(Boolean)
    .slice(0, CTA_MAX_LINES);
  return typed.length ? typed : (DEFAULT_CTA[platform] || FOLLOW).slice();
}

/** Settings as typed into { on, sec, lists: { platform: [lines] } }. */
export function normalizeVideoCta(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = Number(r.sec);
  const sec = CTA_SEC_OPTIONS.includes(s) ? s : 4;
  const lists = {};
  for (const p of CTA_PLATFORMS) lists[p] = ctaLines((r.lists || {})[p], p);
  return { on: String(r.on || '').toLowerCase() === 'on', sec, lists };
}

/** Each channel's line for this video: the turn-th line of its list, wrapping round. */
export function ctaPlan({ platforms = [], lists = {}, turn = 0 } = {}) {
  const t = Math.max(0, Math.floor(Number(turn) || 0));
  const plan = {};
  for (const p of platforms) {
    const list = lists[p] && lists[p].length ? lists[p] : ctaLines('', p);
    plan[p] = list[t % list.length];
  }
  return plan;
}

/** Channels grouped by line, so each distinct line is rendered once: Map(line -> [platforms]). */
export function ctaGroups(plan = {}) {
  const groups = new Map();
  for (const [p, text] of Object.entries(plan)) {
    if (!text) continue;
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(p);
  }
  return groups;
}

/** Centred on the middle of the video, `sec` long. null when the video is too short to carry it. */
export function ctaWindow(durationSec, sec = 4) {
  const d = Number(durationSec) || 0;
  const s = Math.max(1, Number(sec) || 4);
  if (d < s + 4) return null;
  const start = Math.round((d / 2 - s / 2) * 10) / 10;
  return { start, end: Math.round((start + s) * 10) / 10 };
}

const evenDim = (n, d) => Math.max(2, Math.round((Number(n) > 0 ? Number(n) : d) / 2) * 2);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Words wrapped to lines of at most `maxChars`, at most `maxLines` lines. */
export function wrapCta(text, maxChars, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((`${cur} ${w}`).length <= maxChars) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
}

/**
 * The overlay: a transparent frame the video's size with one rounded pill in the
 * upper part (clear of subtitles at the bottom), white bold text on it. YouTube
 * gets its red, the rest a dark pill.
 */
export function ctaBannerSvg({ w = 1080, h = 1920, text = '', platform = '' }) {
  const W = evenDim(w, 1080);
  const H = evenDim(h, 1920);
  const short = Math.min(W, H);
  const size = Math.round(short * (W < H ? 0.062 : 0.05));
  const maxChars = Math.max(12, Math.floor((W * 0.78) / (size * 0.58)));
  const lines = wrapCta(text, maxChars, 2);
  const lh = Math.round(size * 1.25);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const padX = Math.round(size * 0.9);
  const padY = Math.round(size * 0.55);
  const boxW = Math.min(Math.round(W * 0.92), Math.round(longest * size * 0.58 + padX * 2));
  const boxH = lines.length * lh + padY * 2 - Math.round(lh - size);
  const x = Math.round((W - boxW) / 2);
  const y = Math.round(H * (W < H ? 0.2 : 0.12));
  const fill = platform === 'youtube' ? '#E62117' : '#111111';
  const opacity = platform === 'youtube' ? '0.95' : '0.82';
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  const texts = lines.map((l, i) => `<text x="${W / 2}" y="${y + padY + size * 0.92 + i * lh}" text-anchor="middle" ${font} font-weight="700" font-size="${size}" fill="#FFFFFF">${esc(l)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${Math.round(boxH / 2.2)}" fill="${fill}" fill-opacity="${opacity}"/>${texts.join('')}</svg>`;
}

/**
 * ffmpeg args: the video with the overlay PNG faded in and out between
 * `start` and `end` seconds. Sound is copied untouched; the picture is
 * re-encoded the same way Clean does it.
 */
export function ctaOverlayArgs({ input, overlay, output, start, end, fps = 30, anim = null, hasAudio = true, totalSec = 0 }) {
  if (!input || !overlay || !output) throw new Error('ctaOverlayArgs needs input, overlay and output');
  const s = Number(start) || 0;
  const e = Math.max(s + 1, Number(end) || 0);
  const r = Math.min(60, Math.max(1, Math.round(Number(fps) || 30)));
  const fade = 0.35;
  const pill = `[1:v]format=rgba,fade=t=in:st=${s}:d=${fade}:alpha=1,fade=t=out:st=${Math.round((e - fade) * 100) / 100}:d=${fade}:alpha=1[ov]`;
  if (!anim) {
    const graph = [pill, `[0:v][ov]overlay=0:0:shortest=1:enable='between(t,${s},${e})',format=yuv420p[v]`].join(';');
    return [
      '-y', '-i', input,
      '-loop', '1', '-framerate', String(r), '-i', overlay,
      '-filter_complex', graph,
      '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      output,
    ];
  }
  // With the animation: its frames come in at its start time (input 2), float
  // over the video, then the text line; the tap sounds are mixed under the
  // video's own sound (or silence when it has none).
  const sounds = anim.sounds || [];
  const base = hasAudio ? '[0:a]' : '[3:a]';
  const graph = [
    pill,
    `[0:v][2:v]overlay=${anim.x}:${anim.y}:eof_action=pass[va]`,
    `[va][ov]overlay=0:0:shortest=1:enable='between(t,${s},${e})',format=yuv420p[v]`,
    `${base}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]`,
    ...sounds,
    `[a0]${sounds.map((_, i) => `[s${i}]`).join('')}amix=inputs=${sounds.length + 1}:duration=first:dropout_transition=0:normalize=0[a]`,
  ].join(';');
  return [
    '-y', '-i', input,
    '-loop', '1', '-framerate', String(r), '-i', overlay,
    '-itsoffset', String(anim.start), '-framerate', String(anim.fps || 30), '-i', anim.pattern,
    ...(hasAudio ? [] : ['-f', 'lavfi', '-t', String(Math.max(1, Math.ceil(Number(totalSec) || 1))), '-i', 'anullsrc=r=48000:cl=stereo']),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output,
  ];
}

const mediaUrlOf = (cfg) => (((cfg && Array.isArray(cfg.media) && cfg.media[0]) || {}).url) || '';

/** The channels whose post carries one of these videos (not a picture step-down): { platform: sourceUrl }. */
export function videoPlatforms(configs = {}, videoUrls = []) {
  const urls = new Set((Array.isArray(videoUrls) ? videoUrls : [videoUrls]).filter(Boolean));
  const out = {};
  if (!urls.size || !configs) return out;
  for (const p of Object.keys(configs)) {
    const url = mediaUrlOf(configs[p]);
    if (CTA_PLATFORMS.includes(p) && urls.has(url)) out[p] = url;
  }
  return out;
}

/** The configs with each channel's own CTA copy as its video; thumbnails and everything else kept. */
export function withCtaVideos(configs = {}, urlByPlatform = {}) {
  const out = {};
  for (const [p, cfg] of Object.entries(configs || {})) {
    const url = urlByPlatform[p];
    out[p] = url && mediaUrlOf(cfg) ? { ...cfg, media: [{ ...cfg.media[0], url }, ...cfg.media.slice(1)] } : cfg;
  }
  return out;
}

/**
 * The renders one post needs: channels sharing a source video, a line and a
 * look share one. Map(key -> { source, text, look, platforms }); `look` is the
 * channel whose animation it carries (animated) or its pill colour.
 */
export function renderGroups({ sources = {}, plan = {}, animated = false } = {}) {
  const groups = new Map();
  for (const [p, source] of Object.entries(sources)) {
    const text = plan[p];
    if (!text) continue;
    const look = animated ? p : (p === 'youtube' ? 'youtube' : 'dark');
    const key = `${source}\n${text}\n${look}`;
    if (!groups.has(key)) groups.set(key, { source, text, look, platforms: [] });
    groups.get(key).platforms.push(p);
  }
  return groups;
}

/** The configs with these channels' videos pointed at `url` (their old call-to-action copies dropped). */
export function pointVideos(configs = {}, platforms = [], url = '') {
  const out = { ...(configs || {}) };
  for (const p of platforms) {
    const cfg = out[p];
    if (url && cfg && Array.isArray(cfg.media) && cfg.media[0]) out[p] = { ...cfg, media: [{ ...cfg.media[0], url }, ...cfg.media.slice(1)] };
  }
  return out;
}

export default {
  pointVideos, renderGroups, CTA_PLATFORMS, DEFAULT_CTA, CTA_MAX_LINES, CTA_MAX_CHARS, CTA_SEC_OPTIONS, ctaLines, normalizeVideoCta, ctaPlan, ctaGroups,
  ctaWindow, wrapCta, ctaBannerSvg, ctaOverlayArgs, videoPlatforms, withCtaVideos,
};
