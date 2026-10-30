/**
 * Ready-video clean-up (pure — no I/O).
 *
 * Purpose:      Remove a corner watermark and a branded outro (e.g. NotebookLM)
 *               from a finished video: zoom in keeping the TOP of the frame
 *               fixed, so the bottom band (and the watermark in it) moves out of
 *               the picture, then cut the last few seconds.
 * Responsibility:
 *               - normalizeCleanOpts({ zoomPct, trimEndSec }): clamped options
 *               - cleanVideoArgs({ input, output, zoomPct, keepSec }): ffmpeg args
 * Dependencies: none.
 */

/** Clamp the operator's options: zoom 0–30 %, trim 0–60 s. */
export function normalizeCleanOpts({ zoomPct = 10, trimEndSec = 0 } = {}) {
  const z = Number(zoomPct);
  const t = Number(trimEndSec);
  return {
    zoomPct: Number.isFinite(z) ? Math.min(30, Math.max(0, Math.round(z * 10) / 10)) : 10,
    trimEndSec: Number.isFinite(t) ? Math.min(60, Math.max(0, Math.round(t * 10) / 10)) : 0,
  };
}

/**
 * ffmpeg args: scale up by zoomPct, crop back to the original size anchored at
 * the top (centred left/right), keep the first `keepSec` seconds (0 = all).
 */
export function cleanVideoArgs({ input, output, zoomPct = 10, keepSec = 0 }) {
  if (!input || !output) throw new Error('cleanVideoArgs needs input and output');
  const f = 1 + (Number(zoomPct) || 0) / 100;
  const vf = f > 1
    ? `scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2,crop=trunc(iw/${f}/2)*2:trunc(ih/${f}/2)*2:(iw-ow)/2:0,setsar=1`
    : 'setsar=1';
  return [
    '-y', '-i', input,
    ...(keepSec > 0 ? ['-t', String(keepSec)] : []),
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output,
  ];
}

/**
 * The end card the operator typed: black screen, centred white text, the link
 * on its own line, shown for `sec` seconds after the video. sec 0 or no text
 * and no link = no card.
 */
export function normalizeEndCard({ endText = '', endLink = '', endSec = 0 } = {}) {
  const text = String(endText || '').replace(/\r\n/g, '\n').trim().slice(0, 300);
  const link = String(endLink || '').trim().slice(0, 300);
  const s = Number(endSec);
  const sec = Number.isFinite(s) ? Math.min(15, Math.max(0, Math.round(s * 10) / 10)) : 0;
  return text || link ? { endText: text, endLink: link, endSec: sec } : { endText: '', endLink: '', endSec: 0 };
}

const evenDim = (n, d) => Math.max(2, Math.round((Number(n) > 0 ? Number(n) : d) / 2) * 2);

/**
 * The end card as an SVG (rendered to PNG by sharp, the same text renderer the
 * thumbnails use): the operator's lines wrapped to fit, centred, the link
 * below in a smaller size — sized so it reads clearly on a phone.
 */
export function endCardSvg({ w = 1080, h = 1920, text = '', link = '' }) {
  const W = evenDim(w, 1080);
  const H = evenDim(h, 1920);
  const size = Math.round(Math.min(W * 0.068, H * 0.075));
  const maxChars = Math.max(10, Math.floor((W * 0.86) / (size * 0.56)));
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let cur = '';
    for (const word of words) {
      if (!cur) cur = word;
      else if ((`${cur} ${word}`).length <= maxChars) cur += ` ${word}`;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
  }
  const shown = lines.slice(0, 8);
  const l = String(link || '').trim();
  const linkSize = l ? Math.round(Math.min(size * 0.8, (W * 0.92) / (l.length * 0.55))) : 0;
  const lh = Math.round(size * 1.3);
  const gap = shown.length && l ? Math.round(size * 0.9) : 0;
  const block = shown.length * lh + gap + (l ? Math.round(linkSize * 1.3) : 0);
  let y = Math.round((H - block) / 2 + size);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const font = 'font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif"';
  const out = [];
  for (const line of shown) {
    out.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" ${font} font-weight="700" font-size="${size}" fill="#FFFFFF">${esc(line)}</text>`);
    y += lh;
  }
  if (l) {
    y += gap - lh + Math.round(linkSize * 1.3);
    if (!shown.length) y = Math.round((H + linkSize) / 2);
    out.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" ${font} font-weight="600" font-size="${linkSize}" fill="#FFFFFF">${esc(l)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000000"/>${out.join('')}</svg>`;
}

/**
 * ffmpeg args for clean + end card: the zoomed / trimmed video, then the card
 * image held for `cardSec` seconds (with silence when the video has sound),
 * joined into one file at the video's own size and frame rate.
 */
export function cleanWithCardArgs({ input, card, output, zoomPct = 10, keepSec = 0, cardSec = 4, w, h, fps = 30, hasAudio = true }) {
  if (!input || !card || !output) throw new Error('cleanWithCardArgs needs input, card and output');
  const W = evenDim(w, 1080);
  const H = evenDim(h, 1920);
  const r = Math.min(60, Math.max(1, Math.round(Number(fps) || 30)));
  const f = 1 + (Number(zoomPct) || 0) / 100;
  const zoom = f > 1 ? `scale=trunc(iw*${f}/2)*2:trunc(ih*${f}/2)*2,crop=trunc(iw/${f}/2)*2:trunc(ih/${f}/2)*2:(iw-ow)/2:0,` : '';
  const norm = `scale=${W}:${H},setsar=1,fps=${r},format=yuv420p`;
  const graph = [
    `[0:v]${zoom}${norm}[v0]`,
    `[1:v]${norm}[v1]`,
    ...(hasAudio
      ? ['[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]', '[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a1]', '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]']
      : ['[v0][v1]concat=n=2:v=1:a=0[v]']),
  ].join(';');
  return [
    '-y',
    ...(keepSec > 0 ? ['-t', String(keepSec)] : []), '-i', input,
    '-loop', '1', '-framerate', String(r), '-t', String(cardSec), '-i', card,
    ...(hasAudio ? ['-f', 'lavfi', '-t', String(cardSec), '-i', 'anullsrc=r=48000:cl=stereo'] : []),
    '-filter_complex', graph,
    '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    output,
  ];
}

/**
 * Seconds of output written so far, from a chunk of `ffmpeg -progress` output
 * (the last out_time_us / out_time_ms in it); -1 when the chunk has none.
 * Both keys are microseconds (out_time_ms is misnamed by ffmpeg).
 */
export function progressSeconds(chunk) {
  const m = [...String(chunk || '').matchAll(/out_time_(?:us|ms)=(\d+)/g)];
  return m.length ? Number(m[m.length - 1][1]) / 1e6 : -1;
}

/** Whole percent of `totalSec` done (0–99 while running; 0 when unknown). */
export function progressPct(doneSec, totalSec) {
  if (!(totalSec > 0) || !(doneSec > 0)) return 0;
  return Math.min(99, Math.floor((doneSec / totalSec) * 100));
}

export default { normalizeCleanOpts, normalizeEndCard, endCardSvg, cleanVideoArgs, cleanWithCardArgs, progressSeconds, progressPct };
