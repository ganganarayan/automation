/**
 * Image post → YouTube Short.
 *
 * Purpose:      YouTube has no way to publish an image through its API, so an
 *               image post reaches it as a short static vertical video with
 *               soft music. Local ffmpeg only: no AI, no per-render cost.
 * Responsibility: The music choices, the title, and the ffmpeg argv (pure).
 *               Every built-in track is synthesised by ffmpeg, so there is no
 *               music file to license and nothing for a copyright claim to match.
 * Dependencies: none.
 */

export const SHORT_SECONDS = 10;

const tone = (hz, amp = 1) => `${amp}*sin(2*PI*${hz}*t)`;
const swell = (hz, low = 0.75) => `(${low}+${1 - low}*sin(2*PI*${hz}*t))`;
// A soft-attack note that rings out and repeats every `every` seconds.
const note = (hz, every, offset, decay, body) => `exp(-${decay}*mod(t+${offset},${every}))*min(1,20*mod(t+${offset},${every}))*(${body(hz)})`;
const pluck = (hz) => `${tone(hz)}+${tone(hz * 2, 0.5)}+${tone(hz * 3, 0.25)}`;
const bell = (hz) => tone(hz);

/** Value + label for Settings; expr is the ffmpeg aevalsrc expression. */
export const MUSIC_TRACKS = [
  {
    value: 'calm_pad',
    label: 'Calm pad: slow, open, gentle swell',
    expr: `0.12*(${tone(220)}+${tone(277.18)}+${tone(329.63)}+${tone(440, 0.5)})*${swell(0.2)}`,
  },
  {
    value: 'tanpura',
    label: 'Tanpura drone: Indian, meditative, plucked',
    expr: `0.1*(${[[196, 0], [261.63, 2.25], [261.63, 1.5], [130.81, 0.75]].map(([hz, off]) => note(hz, 3, off, 0.7, pluck)).join('+')})`,
  },
  {
    value: 'soft_chimes',
    label: 'Soft chimes: light bells over a quiet pad',
    expr: `0.14*(${[[523.25, 0], [659.25, 1.9], [783.99, 1.25], [1046.5, 0.6]].map(([hz, off]) => note(hz, 2.5, off, 1.2, bell)).join('+')})+0.05*(${tone(261.63)}+${tone(392)})`,
  },
  {
    value: 'warm_drone',
    label: 'Warm drone: deep and very still',
    expr: `0.2*(${tone(110)}+${tone(164.81, 0.7)}+${tone(220, 0.5)})*${swell(0.12, 0.7)}`,
  },
];
export const DEFAULT_MUSIC = MUSIC_TRACKS[0].value;
export const OWN_MUSIC = 'own';

/** Settings' dropdown: the built-in tracks, then your own file. */
export const MUSIC_OPTIONS = [
  ...MUSIC_TRACKS.map(({ value, label }) => ({ value, label })),
  { value: OWN_MUSIC, label: 'My own music (the link below)' },
];

const DRIVE_ID = /(?:\/d\/|[?&]id=)([\w-]{10,})/;

/** A public link to the music: a Drive share link becomes its download link. */
export function musicLink(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  const drive = /google\.com/i.test(s) && s.match(DRIVE_ID);
  return drive ? `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t` : s;
}

/** What to play: { url } for your own file, else { expr }. A bad choice falls back to the default. */
export function pickMusic({ track = '', url = '' } = {}) {
  const own = musicLink(url);
  if (track === OWN_MUSIC && own) return { url: own };
  const found = MUSIC_TRACKS.find((t) => t.value === track) || MUSIC_TRACKS[0];
  return { expr: found.expr };
}

/** The Short's title: the instance title without its date, else the text without its link. YouTube allows 100 characters. */
export function shortTitle(title = '', caption = '') {
  const head = String(title || '').replace(/ · \d{2}-\d{2}-\d{4}$/, '').trim();
  const text = (head !== 'Image post' && head) || String(caption || '').replace(/https?:\/\/\S+/g, '').trim().split('\n')[0];
  return text.slice(0, 100).trim() || 'Short';
}

/** An image post sent as a video (every channel) is this long, or longer when the voice needs it. */
export const IMAGE_VIDEO_SECONDS = 8;
/** Longest video an image post becomes: a long caption is cut before it is read. */
export const IMAGE_VIDEO_MAX_SECONDS = 60;
/** About 14 spoken characters a second, so this keeps the voice inside the max. */
export const VOICE_MAX_CHARS = 700;

/** Settings: image posts go out as a video (default) or as the picture. */
export const IMAGE_VIDEO_OPTIONS = [
  { value: 'on', label: 'Video: the picture with music and the caption read aloud (default)' },
  { value: 'music', label: 'Video: the picture with music, no voice' },
  { value: 'off', label: 'Picture (YouTube still gets a Short)' },
];

/** The image-post mode from Settings; blank or unknown = 'on'. */
export function imageVideoMode(value) {
  const v = String(value || '').trim();
  return IMAGE_VIDEO_OPTIONS.some((o) => o.value === v) ? v : 'on';
}

/**
 * The caption as something to read aloud: no links, hashtags, mentions or
 * emoji, cut at a sentence end under VOICE_MAX_CHARS.
 */
export function voiceText(caption = '') {
  let s = String(caption || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(^|\s)[#@][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[*_~`>|]+/g, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('. ')
    .replace(/([.!?:;,])\.\s/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > VOICE_MAX_CHARS) {
    const cut = s.slice(0, VOICE_MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > VOICE_MAX_CHARS / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '');
  }
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

const LONG_TEXT = new Set(['linkedin', 'facebook', 'youtube']);

/**
 * Per-platform configs for an image post sent as a video: the long caption
 * where there is room, the short one elsewhere, the picture as every cover
 * (and as the Threads and X step-down art), and YouTube's title.
 */
export function imageVideoConfigs({ platforms = [], full = '', short = '', title = '', videoUrl, imageUrl }) {
  const media = [imageUrl ? { url: videoUrl, thumbnail_url: imageUrl } : { url: videoUrl, thumbnail_timestamp_ms: 0 }];
  const out = {};
  for (const k of new Set(platforms)) {
    if (!k) continue;
    const caption = LONG_TEXT.has(k) ? (full || short) : (short || full);
    out[k] = { caption, media, ...(k === 'youtube' ? { title } : {}) };
  }
  return out;
}

/** Video length for a voice of `voiceSec`: at least 8 s, the voice plus 1.5 s, at most 60 s. */
export function imageVideoSeconds(voiceSec = 0) {
  const v = Number(voiceSec) || 0;
  if (v <= 0) return IMAGE_VIDEO_SECONDS;
  return Math.min(IMAGE_VIDEO_MAX_SECONDS, Math.max(IMAGE_VIDEO_SECONDS, Math.ceil(v + 1.5)));
}

/**
 * ffmpeg argv: the image, whole, on a blurred copy of itself at 1080x1920, with
 * the music faded in and out. With a voice file, the music drops low and the
 * voice starts half a second in.
 */
export function imageShortArgs({ imagePath, outPath, music = {}, seconds = SHORT_SECONDS, voicePath = '' }) {
  const audioIn = music.file
    ? ['-stream_loop', '-1', '-i', music.file]
    : ['-f', 'lavfi', '-i', `aevalsrc=exprs='${music.expr}':s=44100:c=stereo`];
  const voiceIn = voicePath ? ['-i', voicePath] : [];
  const musicChain = `aresample=44100,aformat=channel_layouts=stereo,${voicePath ? 'volume=0.25,' : ''}afade=t=in:d=1,afade=t=out:st=${seconds - 2}:d=2`;
  const audio = voicePath
    ? [
      `[1:a]${musicChain}[m]`,
      '[2:a]aresample=44100,aformat=channel_layouts=stereo,adelay=500|500,apad[vo]',
      '[m][vo]amix=inputs=2:duration=first:normalize=0[a]',
    ]
    : [`[1:a]${musicChain}[a]`];
  const filter = [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2[bg]',
    '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
    ...audio,
  ].join(';');
  return [
    '-y', '-loop', '1', '-framerate', '30', '-i', imagePath, ...audioIn, ...voiceIn,
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath,
  ];
}

export default {
  SHORT_SECONDS, MUSIC_TRACKS, MUSIC_OPTIONS, DEFAULT_MUSIC, OWN_MUSIC, musicLink, pickMusic, shortTitle, imageShortArgs,
  IMAGE_VIDEO_SECONDS, IMAGE_VIDEO_MAX_SECONDS, VOICE_MAX_CHARS, IMAGE_VIDEO_OPTIONS, imageVideoMode, voiceText, imageVideoSeconds, imageVideoConfigs,
};
