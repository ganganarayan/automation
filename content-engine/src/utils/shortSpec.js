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

/**
 * A track's ffmpeg expression as a JavaScript one of (t, mod), so Settings can
 * play it in the browser exactly as the video will have it.
 */
export function musicJsExpr(expr = '') {
  return String(expr).replace(/\b(sin|exp|min)\(/g, 'Math.$1(').replace(/\bPI\b/g, 'Math.PI');
}

/** Settings' dropdown: the built-in tracks, then your own file. */
export const MUSIC_OPTIONS = [
  ...MUSIC_TRACKS.map(({ value, label }) => ({ value, label })),
  { value: OWN_MUSIC, label: 'My own music (the link below)' },
];

const DRIVE_ID = /(?:\/d\/|[?&]id=)([\w-]{10,})/;

/** Sites that give a web page, not a music file (YouTube, Spotify, SoundCloud...). */
export const MUSIC_PAGE_SITES = /^https?:\/\/([^/]*\.)?(youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|apple\.com|jiosaavn\.com|gaana\.com|wynk\.in)(\/|$)/i;

/** True for a link to a music site's page, which cannot be played or mixed. */
export function isMusicPage(url) {
  return MUSIC_PAGE_SITES.test(String(url || '').trim());
}

/** A Drive folder link: its files are read by musicFolderService before a pick. */
export function isMusicFolder(url) {
  return /^https?:\/\/drive\.google\.com\/.*\/folders\/[\w-]{10,}/i.test(String(url || '').trim());
}

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/**
 * The audio files of a listed folder, each with the id of the .txt that has
 * the same name (its credit), A to Z: [{ id, name, textId }].
 */
export function musicFolderPairs(files = []) {
  const base = (n) => String(n || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
  const texts = new Map(files.filter((f) => /\.txt$/i.test(f.name || '')).map((f) => [base(f.name), f.id]));
  return files
    .filter((f) => AUDIO_EXT.test(f.name || '') || /^audio\//i.test(f.mimeType || ''))
    .map((f) => ({ id: f.id, name: f.name, textId: texts.get(base(f.name)) || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A web page came back instead of a music file. */
export function notAudio(contentType = '') {
  return /text\/html|application\/json/i.test(String(contentType));
}

/** A public link to the music: a Drive share link becomes its download link. A music site's page gives '' so the default track plays. */
export function musicLink(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s) || isMusicPage(s) || isMusicFolder(s)) return '';
  const drive = /google\.com/i.test(s) && s.match(DRIVE_ID);
  return drive ? `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t` : s;
}

/**
 * Your music, one per line as "link | credit" (the credit is optional). A line
 * with no "|" may hold several links split by spaces or commas. Returns the
 * usable ones, no repeats: [{ url, credit }].
 */
export function musicEntries(text = '') {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const bar = line.indexOf('|');
    const pairs = bar >= 0
      ? [[line.slice(0, bar), line.slice(bar + 1)]]
      : line.split(/[\s,]+/).map((s) => [s, '']);
    for (const [raw, credit] of pairs) {
      const url = musicLink(raw);
      // A credit's own line breaks arrive as \\n (one track per line); its whole text is kept.
      if (url && !out.has(url)) out.set(url, String(credit || '').split('\\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    }
  }
  return [...out].map(([url, credit]) => ({ url, credit }));
}

/**
 * A festival post's music, as a shortMusic setting: 'random' (or blank) = your
 * music as set, 'none' = the voice only, else that one link with its credit.
 */
export function musicChoice(shortMusic = {}, choice = '', credit = '') {
  const c = String(choice || '').trim();
  if (!c || c === 'random') return shortMusic || {};
  if (c === 'none') return { ...(shortMusic || {}), url: '' };
  const cr = String(credit || '').replace(/\|/g, ' ').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\\n');
  return { ...(shortMusic || {}), url: cr ? `${c} | ${cr}` : c };
}

/** Your usable music links. */
export function musicLinks(text = '') {
  return musicEntries(text).map((e) => e.url);
}

/**
 * The caption with the music credit on its own last line. With max, the
 * credit is added only when it still fits, so a short caption is never cut.
 */
export function withMusicCredit(caption = '', credit = '', max = 0) {
  const c = String(credit || '').trim();
  const text = String(caption || '');
  if (!c || !text || text.includes(c)) return text;
  const out = `${text.trimEnd()}\n\n🎵 ${c}`;
  return max && out.length > max ? text : out;
}

/** What to play: { url } for your own file, else { expr }. A bad choice falls back to the default. */
export function pickMusic({ track = '', url = '' } = {}, rand = Math.random) {
  const all = musicEntries(url);
  const own = all.map((e) => e.url);
  const credits = Object.fromEntries(all.filter((e) => e.credit).map((e) => [e.url, e.credit]));
  const withCredits = (o) => (Object.keys(credits).length ? { ...o, credits } : o);
  // Your music only: the old built-in tracks are gone, so the choice (track) no longer matters.
  if (own.length === 1) return withCredits({ url: own[0] });
  if (own.length) {
    // One of your links at random per video; the rest are tried in turn if it fails.
    const start = Math.floor(rand() * own.length) % own.length;
    const urls = [...own.slice(start), ...own.slice(0, start)];
    return withCredits({ url: urls[0], urls });
  }
  return {};
}

/** The Short's title: the instance title without its date, else the text without its link. YouTube allows 100 characters. */
export function shortTitle(title = '', caption = '') {
  const head = String(title || '').replace(/ · \d{2}-\d{2}-\d{4}$/, '').trim();
  const text = (head !== 'Image post' && head) || String(caption || '').replace(/https?:\/\/\S+/g, '').trim().split('\n')[0];
  return text.slice(0, 100).trim() || 'Short';
}

/** An image post sent as a video with no voice (music only) is this long. */
export const IMAGE_VIDEO_SECONDS = 8;
/**
 * Longest video an image post becomes: under 3 minutes, so YouTube still takes
 * it as a Short. Only a caption longer than about VOICE_MAX_CHARS is cut.
 */
export const IMAGE_VIDEO_MAX_SECONDS = 175;
/** About 14 spoken characters a second, so this keeps the voice inside the max. */
export const VOICE_MAX_CHARS = 2400;
/** The voice starts this far in, and the picture holds this long after it ends. */
export const VOICE_LEAD_SECONDS = 0.5;
export const VOICE_TAIL_SECONDS = 1;

/** Settings: image posts go out as a video (default) or as the picture. */
export const IMAGE_VIDEO_OPTIONS = [
  { value: 'on', label: 'Video: the picture with music and the caption read aloud (default)' },
  { value: 'off', label: 'Picture (YouTube still gets a Short)' },
];

/** The image-post mode: always 'on' (a voiced video). */
export function imageVideoMode() {
  // Every image post goes out as a video with the voice, YouTube Shorts
  // included: there is no picture-only choice any more (an old saved 'off' is ignored).
  return 'on';
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
 * The three sizes an image post is drawn and rendered in. gen = the image
 * size key the picture is generated at (utils/imageGateSpec IMAGE_SIZES).
 */
export const IMAGE_VIDEO_SIZES = {
  portrait: { w: 1080, h: 1920, label: '9:16', gen: 'story', frame: 'tall vertical 9:16 frame' },
  feed: { w: 1080, h: 1350, label: '4:5', gen: 'feed', frame: 'vertical 4:5 feed frame' },
  landscape: { w: 1920, h: 1080, label: '16:9', gen: 'landscape', frame: 'wide horizontal 16:9 frame' },
};

/** Which size each platform gets: full-screen vertical where it plays as a Reel or Short. */
export const VIDEO_PLATFORM_SIZE = {
  instagram: 'portrait',
  youtube: 'portrait',
  facebook: 'portrait',
  tiktok: 'portrait',
  threads: 'feed',
  linkedin: 'feed',
  pinterest: 'feed',
  x: 'landscape',
};
/** The size a post with no platform of its own goes in. */
export const PRIMARY_SIZE = 'portrait';

export const sizeFor = (platform) => VIDEO_PLATFORM_SIZE[platform] || PRIMARY_SIZE;

/** The sizes these platforms need, the primary always first. */
export function sizesNeeded(platforms = []) {
  return [...new Set([PRIMARY_SIZE, ...platforms.filter(Boolean).map(sizeFor)])];
}

/** The image prompt for one size: the same scene, composed for that frame, text kept clear of the edges. */
export function sizedPrompt(prompt, size) {
  const s = IMAGE_VIDEO_SIZES[size];
  if (!s) return prompt;
  return `${prompt}\n\nCOMPOSITION: a ${s.frame}. Keep every piece of text and every face well inside the frame, clear of the edges.`;
}

/**
 * Per-platform configs for an image post sent as a video: the long caption
 * where there is room, the short one elsewhere, each platform's own size of
 * video with its own size of picture as the cover (and as the Threads and X
 * step-down art), and YouTube's title. videos/images: size -> URL; a missing
 * size uses the primary.
 */
export function imageVideoConfigs({ platforms = [], full = '', short = '', title = '', videos = {}, images = {} }) {
  const out = {};
  for (const k of new Set(platforms)) {
    if (!k) continue;
    const size = sizeFor(k);
    const url = videos[size] || videos[PRIMARY_SIZE];
    const cover = images[size] || images[PRIMARY_SIZE];
    const media = [cover ? { url, thumbnail_url: cover } : { url, thumbnail_timestamp_ms: 0 }];
    const caption = LONG_TEXT.has(k) ? (full || short) : (short || full);
    out[k] = { caption, media, ...(k === 'youtube' ? { title } : {}) };
  }
  return out;
}

/** Words per subtitle line, and the most characters on one. */
const CUE_WORDS = 5;
const CUE_CHARS = 30;

function groupWords(words) {
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (cur.length && (cur.length >= CUE_WORDS || len > CUE_CHARS)) flush();
    cur.push(w);
    if (/[.!?;:,]$/.test(w.text) && cur.length >= 2) flush();
  }
  flush();
  // Each line stays up until the next one starts, so there is no flicker between them.
  return cues.map((c, i) => ({ ...c, end: i + 1 < cues.length ? Math.max(c.end, cues[i + 1].start) : c.end + 0.3 }));
}

/**
 * Subtitle cues from ElevenLabs' character timings, shifted by `offset` (the
 * voice starts half a second in). [] when there are none.
 */
export function alignmentCues(alignment = {}, offset = 0.5) {
  const chars = alignment.characters || [];
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) { if (cur) words.push(cur); cur = null; continue; }
    if (!cur) cur = { text: '', start: (Number(starts[i]) || 0) + offset, end: 0 };
    cur.text += ch;
    cur.end = (Number(ends[i]) || 0) + offset;
  }
  if (cur) words.push(cur);
  return groupWords(words.filter((w) => w.text));
}

/** Cues spread evenly over `seconds` when there are no timings (by word length). */
export function evenCues(text = '', seconds = 0, offset = 0.5) {
  const list = String(text || '').split(/\s+/).filter(Boolean);
  if (!list.length || !(seconds > 0)) return [];
  const total = list.reduce((n, w) => n + w.length + 1, 0);
  let t = offset;
  const words = list.map((w) => {
    const d = (seconds * (w.length + 1)) / total;
    const word = { text: w, start: t, end: t + d };
    t += d;
    return word;
  });
  return groupWords(words);
}

/** Settings: where image-post videos are made, start to finish (pictures, voice, subtitles, videos). */
export const VIDEO_RUNNER_OPTIONS = [
  { value: 'github', label: 'GitHub Actions (no Railway egress or memory; files go to your Google Drive)' },
  { value: 'railway', label: 'Railway (this server)' },
];
export const FAILSAFE_OPTIONS = [
  { value: 'on', label: 'Yes: if it fails there, make it on the other one' },
  { value: 'off', label: 'No: stop and say why' },
];
/** The chosen place; blank or unknown = GitHub. */
export const videoRunner = (v) => (String(v || '').trim() === 'railway' ? 'railway' : 'github');
export const otherRunner = (r) => (r === 'github' ? 'railway' : 'github');
/** The fail-safe; blank = on. */
export const failSafeOn = (v) => String(v || '').trim() !== 'off';

/** ffmpeg crop to an aspect ('9:16'), centred, for runners without sharp. '' = none. */
export function aspectCropFilter(aspect) {
  const m = /^(\d+):(\d+)$/.exec(String(aspect || ''));
  if (!m) return '';
  const [w, h] = [m[1], m[2]];
  return `crop=w='min(iw,ih*${w}/${h})':h='min(ih,iw*${h}/${w})'`;
}

/** Video length: exactly the voice (plus its half-second lead and a one-second hold), else 8 s with no voice. */
export function imageVideoSeconds(voiceSec = 0) {
  const v = Number(voiceSec) || 0;
  if (v <= 0) return IMAGE_VIDEO_SECONDS;
  const len = Math.round((VOICE_LEAD_SECONDS + v + VOICE_TAIL_SECONDS) * 10) / 10;
  return Math.min(IMAGE_VIDEO_MAX_SECONDS, Math.max(3, len));
}

/**
 * ffmpeg argv: the image, whole, on a blurred copy of itself at width x height
 * (1080x1920 by default), optionally with burned subtitles (subPath: a plain
 * file name; ffmpeg runs in its folder), with
 * the music faded in and out. With a voice file, the music drops low and the
 * voice starts half a second in.
 */
/**
 * Where the subtitles sit (libass MarginV, in its 288 rows) when your photo stands
 * on the bottom of the picture: just above your head, so the words never cover
 * you, and never lower than the usual place (clear of the apps' buttons).
 * aspect = picture width / height, photoTop = the photo's top as a share of the
 * picture's height. null when there is no photo (the usual place).
 * Self-contained: the festival page's preview runs this same source.
 */
export function subMarginV({ width = 1080, height = 1920, aspect = 0, photoTop = 0 } = {}) {
  if (!(aspect > 0) || !(photoTop > 0 && photoTop < 1)) return null;
  const tall = height > width;
  const base = tall ? 70 : 30;
  const fs = tall ? 11 : 16;
  const ph = Math.min(width / aspect, height);
  const top = (height - ph) / 2 + photoTop * ph;
  const mv = Math.ceil(((height - top) / height) * 288 + fs * 0.35);
  return Math.max(base, Math.min(mv, 240));
}

/** Each video size's subtitle margin for a festival post with your photo ({} without one). */
export function photoSubMargins(festival = null) {
  const f = festival || {};
  const out = {};
  for (const [size, spec] of Object.entries(IMAGE_VIDEO_SIZES)) {
    const mv = subMarginV({ width: spec.w, height: spec.h, aspect: Number(f.aspect), photoTop: Number(f.photoTop) });
    if (mv) out[size] = mv;
  }
  return out;
}

/** A festival post's subtitles at the top: clear of the apps' top bar (libass rows from the top). */
export const TOP_MARGIN_V = { tall: 36, wide: 20 };

/**
 * The subtitles filter(s). Usual: the spoken lines bottom centre at marginV (or
 * the usual place). Festival (subTop): the spoken lines at the top, and the
 * title (titlePath, one cue for the whole video) bottom centre at marginV.
 */
export function subtitleFilters({ width, height, subPath = '', marginV = null, subTop = false, titlePath = '' }) {
  if (!subPath) return '';
  const tall = height > width;
  const style = (fs, align, mv) => `force_style='Fontsize=${fs},Bold=1,Outline=2,Shadow=0,Alignment=${align},MarginV=${mv}'`;
  const bottom = Number(marginV) > 0 ? Math.round(Number(marginV)) : (tall ? 70 : 30);
  if (!subTop) return `,subtitles=${subPath}:${style(tall ? 11 : 16, 2, bottom)}`;
  // SRT takes the old SSA alignment numbers: 2 is bottom centre, 6 top centre (8 would be middle left).
  const top = `,subtitles=${subPath}:${style(tall ? 11 : 16, 6, tall ? TOP_MARGIN_V.tall : TOP_MARGIN_V.wide)}`;
  return titlePath ? `${top},subtitles=${titlePath}:${style(tall ? 15 : 21, 2, bottom)}` : top;
}

/** Background music under the voice: each funnel sets it (funnel_config music_volume), 25% at most. */
export const MUSIC_VOLUME_MAX = 25;
export const MUSIC_VOLUME_DEFAULT = 20;

/** A funnel's music volume as a % (0..25): blank or unreadable = the default, over the cap = the cap. */
export function musicVolumePct(value) {
  const s = String(value ?? '').trim();
  const n = Number(s);
  if (!s || !Number.isFinite(n)) return MUSIC_VOLUME_DEFAULT;
  return Math.max(0, Math.min(MUSIC_VOLUME_MAX, Math.round(n)));
}

export function imageShortArgs({ imagePath, outPath, music = {}, seconds = SHORT_SECONDS, voicePath = '', width = 1080, height = 1920, subPath = '', marginV = null, subTop = false, titlePath = '', musicVolume = MUSIC_VOLUME_DEFAULT }) {
  if (titlePath && /[\\/:'\\,;[\]]/.test(titlePath)) throw new Error('title path must be a plain relative file name');
  if (subPath && /[\\/:'\\,;[\]]/.test(subPath)) throw new Error('subtitle path must be a plain relative file name');
  // No music that loads = silence under the voice: the video still has its voice.
  const audioIn = music.file
    ? ['-stream_loop', '-1', '-i', music.file]
    : music.expr
      ? ['-f', 'lavfi', '-i', `aevalsrc=exprs='${music.expr}':s=44100:c=stereo`]
      : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  const voiceIn = voicePath ? ['-i', voicePath] : [];
  // Music under the voice at the funnel's level (25% at most); with no voice it plays at full level.
  const musicChain = `aresample=44100,aformat=channel_layouts=stereo,${voicePath ? `volume=${(musicVolumePct(musicVolume) / 100).toFixed(2)},` : ''}afade=t=in:d=1,afade=t=out:st=${seconds - 2}:d=2`;
  const audio = voicePath
    ? [
      `[1:a]${musicChain}[m]`,
      `[2:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${VOICE_LEAD_SECONDS * 1000}|${VOICE_LEAD_SECONDS * 1000},apad[vo]`,
      '[m][vo]amix=inputs=2:duration=first:normalize=0[a]',
    ]
    : [`[1:a]${musicChain}[a]`];
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=30:2[bg]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
    // Subtitles: white on a dark outline, bottom centre, lifted clear of the apps' buttons.
    `[bg][fg]overlay=(W-w)/2:(H-h)/2${subtitleFilters({ width, height, subPath, marginV, subTop, titlePath })},format=yuv420p[v]`,
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
  IMAGE_VIDEO_SECONDS, IMAGE_VIDEO_MAX_SECONDS, VOICE_MAX_CHARS, VOICE_LEAD_SECONDS, VOICE_TAIL_SECONDS, IMAGE_VIDEO_OPTIONS, imageVideoMode, voiceText, imageVideoSeconds, imageVideoConfigs,
  IMAGE_VIDEO_SIZES, VIDEO_PLATFORM_SIZE, PRIMARY_SIZE, sizeFor, sizesNeeded, sizedPrompt, alignmentCues, evenCues,
  VIDEO_RUNNER_OPTIONS, FAILSAFE_OPTIONS, videoRunner, otherRunner, failSafeOn, aspectCropFilter, musicJsExpr, isMusicPage, notAudio, musicLinks, musicEntries, withMusicCredit, isMusicFolder, musicFolderPairs,
};
