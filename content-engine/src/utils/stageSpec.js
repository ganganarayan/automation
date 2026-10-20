/**
 * Stage workers: pure helpers.
 *
 * Purpose:      The deterministic, side-effect-free pieces the pipeline stage
 *               runner needs — script prompt building, splitting a script into
 *               scene prompts, aspect/size mapping, clip-second math, media
 *               naming, SRT building, and the ffmpeg argv for the final stitch.
 *               Kept apart from the runner/providers so they unit-test without
 *               settings, a DB, keys, or the ffmpeg binary (like utils/
 *               animationSpec, utils/videoSchedule).
 * Responsibility: Pure functions only.
 * Dependencies: none.
 */

/** System prompt for script generation (tone is the funnel's script_tone). */
export function scriptSystemPrompt(tone = '') {
  const base =
    'You write short vertical social-video scripts: a strong hook, a tight body, and a clear CTA. '
    + 'Return only the spoken script text — no scene labels, no headings, no stage directions.';
  return [base, String(tone || '').trim()].filter(Boolean).join('\n\n');
}

/** User prompt for script generation from a topic/angle (+ optional correction). */
export function scriptUserPrompt({ topic = '', audience = '', correction = '' } = {}) {
  const lines = [];
  lines.push(topic ? `Topic / angle: ${String(topic).trim()}` : 'Topic: today’s angle for this funnel.');
  if (audience) lines.push(`Audience: ${String(audience).trim()}`);
  if (correction) lines.push(`Apply this correction from the reviewer: ${String(correction).trim()}`);
  lines.push('Write the script now.');
  return lines.join('\n');
}

/** Clamp an images-per-video count into [1, 20] with a fallback. */
export function clampSceneCount(value, fallback = 4) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 20);
}

/**
 * Split a script into exactly `count` scene chunks (deterministic): break on
 * sentence boundaries, distribute as evenly as possible, pad with the last chunk
 * when the script is shorter than count. Empty script => count empty strings.
 */
export function splitScriptToScenes(scriptText, count) {
  const n = clampSceneCount(count, 4);
  const text = String(scriptText || '').replace(/\s+/g, ' ').trim();
  if (!text) return Array.from({ length: n }, () => '');
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const out = [];
  const per = Math.ceil(sentences.length / n);
  for (let i = 0; i < n; i += 1) {
    const chunk = sentences.slice(i * per, i * per + per).join(' ').trim();
    out.push(chunk);
  }
  // If sentences ran out before n chunks, reuse the last non-empty chunk.
  const lastNonEmpty = [...out].reverse().find(Boolean) || sentences[sentences.length - 1] || text;
  return out.map((c) => c || lastNonEmpty);
}

/** Combine a scene description with the funnel's image style into one prompt. */
export function sceneImagePrompt(scene, style = '') {
  return [String(style || '').trim(), String(scene || '').trim()].filter(Boolean).join('. ') || 'cinematic still';
}

/** Aspect ratio -> output pixel size (vertical reel default). */
export function aspectToSize(aspect = '9:16') {
  const map = {
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
  };
  return map[String(aspect)] || map['9:16'];
}

/** Total animated seconds for cost = per-clip length × number of clips. */
export function totalClipSeconds(clipLength, clipCount) {
  const per = String(clipLength) === '10' ? 10 : 5;
  const n = Math.max(0, Math.floor(Number(clipCount) || 0));
  return per * n;
}

/** A safe, unique-ish media file name. */
export function buildMediaName(prefix, stamp, index, ext) {
  const safe = String(prefix || 'media').replace(/[^a-z0-9_-]+/gi, '-');
  const e = String(ext || 'bin').replace(/[^a-z0-9]+/gi, '');
  return `${safe}-${stamp}-${index}.${e}`;
}

/** ffmpeg time (HH:MM:SS,mmm) for an SRT cue from seconds. */
export function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000) || 0);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(millis).padStart(3, '0')}`;
}

/**
 * Build a simple SRT from cue objects [{ start, end, text }] (seconds). Used to
 * burn captions when the funnel's transcript provides timed segments.
 */
export function buildSrt(cues) {
  const list = Array.isArray(cues) ? cues : [];
  return list
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${String(c.text || '').trim()}\n`)
    .join('\n');
}

/**
 * The ffmpeg argv (without the leading "ffmpeg") to stitch N clips + one audio
 * track into a single reel: each clip is scaled+padded to WxH, concatenated, the
 * audio is mapped on, optionally burning a subtitles file. Pure string building
 * so the command is unit-tested; the provider runs it.
 *
 * @param {object} a
 * @param {string[]} a.clipPaths - local clip file paths, in order (>= 1)
 * @param {string}   a.audioPath - local audio file path
 * @param {string}   a.outPath   - output mp4 path
 * @param {number}   a.width
 * @param {number}   a.height
 * @param {string}   [a.subPath] - SRT path to burn in (optional)
 */
export function ffmpegConcatArgs({ clipPaths, audioPath, outPath, width = 1080, height = 1920, subPath = '' }) {
  const clips = (Array.isArray(clipPaths) ? clipPaths : []).filter(Boolean);
  if (!clips.length) throw new Error('ffmpegConcatArgs needs at least one clip');
  if (!audioPath) throw new Error('ffmpegConcatArgs needs an audio path');
  if (!outPath) throw new Error('ffmpegConcatArgs needs an output path');

  const args = ['-y'];
  for (const c of clips) args.push('-i', c);
  args.push('-i', audioPath);

  const scale = (i) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`;
  const parts = clips.map((_, i) => scale(i));
  const concatIn = clips.map((_, i) => `[v${i}]`).join('');
  const concatOut = subPath ? '[vc]' : '[v]';
  parts.push(`${concatIn}concat=n=${clips.length}:v=1:a=0${concatOut}`);
  if (subPath) parts.push(`[vc]subtitles=${subPath}[v]`);

  const audioIndex = clips.length; // audio is the last input
  args.push('-filter_complex', parts.join(';'));
  args.push('-map', '[v]', '-map', `${audioIndex}:a`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart');
  args.push(outPath);
  return args;
}

export default {
  scriptSystemPrompt,
  scriptUserPrompt,
  clampSceneCount,
  splitScriptToScenes,
  sceneImagePrompt,
  aspectToSize,
  totalClipSeconds,
  buildMediaName,
  srtTime,
  buildSrt,
  ffmpegConcatArgs,
};
