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

/**
 * ffmpeg argv: the image, whole, on a blurred copy of itself at 1080x1920, with
 * the music faded in and out.
 */
export function imageShortArgs({ imagePath, outPath, music = {}, seconds = SHORT_SECONDS }) {
  const audioIn = music.file
    ? ['-stream_loop', '-1', '-i', music.file]
    : ['-f', 'lavfi', '-i', `aevalsrc=exprs='${music.expr}':s=44100:c=stereo`];
  const filter = [
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2[bg]',
    '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
    `[1:a]afade=t=in:d=1,afade=t=out:st=${seconds - 2}:d=2[a]`,
  ].join(';');
  return [
    '-y', '-loop', '1', '-framerate', '30', '-i', imagePath, ...audioIn,
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath,
  ];
}

export default { SHORT_SECONDS, MUSIC_TRACKS, MUSIC_OPTIONS, DEFAULT_MUSIC, OWN_MUSIC, musicLink, pickMusic, shortTitle, imageShortArgs };
