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

export default { normalizeCleanOpts, cleanVideoArgs, progressSeconds, progressPct };
