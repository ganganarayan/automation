/**
 * Ready video + AI copy: pure helpers.
 *
 * Purpose:      The settings-free pieces of the "upload a finished video, let the
 *               app transcribe it and write per-video, per-platform copy" lane —
 *               the audio-extract ffmpeg args, the copy prompts, normalising the
 *               model's JSON into the four copy fields, and mapping those fields
 *               onto Post for Me per-platform configurations.
 *
 *               Copy fields (one set per video):
 *                 title       - YouTube title
 *                 description - YouTube description, LinkedIn & Facebook post
 *                               (pages and profiles alike)
 *                 igCaption   - Instagram caption (also TikTok)
 *                 short       - short post for Threads and X
 * Responsibility: Pure functions only.
 * Dependencies: none.
 */

export const LIMITS = {
  title: 100, // YouTube title
  description: 3000, // LinkedIn's cap (YouTube allows 5000)
  igCaption: 2200, // Instagram caption
  x: 280, // X post; a URL counts as 23
  threads: 500, // Threads post
};
const X_URL_LEN = 23;

/** ffmpeg args: pull a small mono speech-grade mp3 out of a video (fits Whisper's 25 MB). */
export function extractAudioArgs({ inPath, outPath }) {
  if (!inPath || !outPath) throw new Error('extractAudioArgs needs inPath and outPath');
  return ['-y', '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outPath];
}

/** System prompt for the copy writer. */
export function copySystemPrompt({ brief = '', audience = '', keyword = '' } = {}) {
  return [
    'You write social-media copy for one short video, from its transcript.',
    'Return ONLY a JSON object with exactly these string keys:',
    '  "title": YouTube title, max 90 characters, no angle brackets, no hashtags.',
    '  "description": a 3-6 short-paragraph post that works as the YouTube description and as a LinkedIn and Facebook post. Hook first line, value in the middle, a clear call to action at the end. Up to 5 relevant hashtags on the last line. No links (the app appends the link).',
    `  "igCaption": an Instagram caption: hook line, 2-4 short lines of value, ${keyword ? `a call to action telling people to comment "${keyword}" to get the link in their DMs` : 'a "link in bio" call to action'}, then 8-15 relevant hashtags. No links.`,
    '  "short": one punchy post for X and Threads, max 220 characters, at most 2 hashtags. No links.',
    'Stay faithful to what is actually said in the video; never invent claims, numbers or names.',
    'Write in the same language as the transcript.',
    brief ? `Brand / voice brief:\n${brief}` : '',
    audience ? `Audience: ${audience}` : '',
  ].filter(Boolean).join('\n');
}

/** User prompt: the transcript (or, for a silent video, just its file name). */
export function copyUserPrompt({ transcript = '', fileName = '' } = {}) {
  const t = String(transcript || '').trim();
  return t
    ? `Video file: ${fileName}\n\nTranscript:\n${t.slice(0, 12000)}`
    : `Video file: ${fileName}\n\nThe video has no speech (music / visuals only). Write the copy from the file name and the brand brief.`;
}

/** Cut text to `max` characters at a word boundary, adding an ellipsis. */
export function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1));
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Normalise the model's JSON (or an edited copy from the UI) into the four fields. */
export function normalizeCopy(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => String(v ?? '').trim();
  return {
    title: clip(str(o.title).replace(/[<>]/g, ''), LIMITS.title),
    description: clip(str(o.description), LIMITS.description),
    igCaption: clip(str(o.igCaption ?? o.ig_caption ?? o.caption), LIMITS.igCaption),
    short: str(o.short ?? o.shortPost ?? o.short_post),
  };
}

/** Append a link on its own line when it's set and not already in the text. */
export function withLink(text, link) {
  const body = String(text || '').trim();
  const l = String(link || '').trim();
  if (!l || body.includes(l)) return body;
  return [body, l].filter(Boolean).join('\n\n');
}

/** The X post: short text clipped so text + link fits 280 (a URL counts as 23). */
export function xPost(short, link) {
  const l = String(link || '').trim();
  const budget = LIMITS.x - (l ? X_URL_LEN + 1 : 0);
  return l ? `${clip(short, budget)}\n${l}` : clip(short, LIMITS.x);
}

/** The Threads post: short text + link, within 500. */
export function threadsPost(short, link) {
  const l = String(link || '').trim();
  const budget = LIMITS.threads - (l ? l.length + 1 : 0);
  return l ? `${clip(short, budget)}\n${l}` : clip(short, LIMITS.threads);
}

/** Map an account-map platform label onto Post for Me's platform key. */
export function platformKey(label) {
  const p = String(label || '').toLowerCase();
  if (p.includes('youtube')) return 'youtube';
  if (p.includes('instagram')) return 'instagram';
  if (p.includes('linkedin')) return 'linkedin';
  if (p.includes('facebook')) return 'facebook';
  if (p.includes('threads')) return 'threads';
  if (p.includes('tiktok')) return 'tiktok';
  if (p === 'x' || p.includes('twitter')) return 'x';
  return '';
}

/**
 * Post for Me platform_configurations for one video's copy. Only the platforms
 * the funnel actually posts to are included; when the account map gives no
 * platform info at all, every supported platform is configured.
 * @returns {{ caption: string, platformConfigurations: object }}
 */
export function platformConfigsFor(copy, { accountIds = [], accountMap = {}, ctaLink = '' } = {}) {
  const c = normalizeCopy(copy);
  const longText = withLink(c.description, ctaLink);
  const all = {
    youtube: { title: c.title, caption: longText },
    linkedin: { caption: longText },
    facebook: { caption: longText },
    instagram: { caption: c.igCaption },
    tiktok: { caption: c.igCaption },
    threads: { caption: threadsPost(c.short, ctaLink) },
    x: { caption: xPost(c.short, ctaLink) },
  };
  const present = new Set((accountIds || []).map((id) => platformKey((accountMap[id] || {}).platform)).filter(Boolean));
  const keys = present.size ? [...present] : Object.keys(all);
  const platformConfigurations = {};
  for (const k of keys) if (all[k]) platformConfigurations[k] = all[k];
  return { caption: longText, platformConfigurations };
}

export default {
  LIMITS, extractAudioArgs, copySystemPrompt, copyUserPrompt, clip, normalizeCopy,
  withLink, xPost, threadsPost, platformKey, platformConfigsFor,
};
