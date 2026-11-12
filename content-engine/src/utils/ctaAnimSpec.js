/**
 * Floating like / follow / bell animation per channel (pure: no I/O).
 *
 * Purpose:      A small animated row that floats over a long ready video while
 *               it keeps playing: a cursor taps the like icon (it pops and fills),
 *               taps the channel's button (Subscribe on YouTube, Follow
 *               elsewhere; it turns to Subscribed / Following), then rings the
 *               bell where the channel has one. A click plays on each tap and a
 *               bell on the ring, mixed under the video's own sound. Nothing is
 *               spoken and the video never pauses.
 * Responsibility:
 *               - ANIM_STYLES: each channel's icons, words and colours
 *               - ANIM_SEC, ANIM_FPS, ANIM_MIN_VIDEO_SEC, ANIM_LEAD_SEC
 *               - animWindow(totalSec, textStart): when it plays (10 s before the
 *                 text line, videos over 3 minutes only), or null
 *               - animTaps(platform): [{ at, sound }] inside the animation
 *               - animLayout({ w, h, platform }): its box size and place on the
 *                 frame (per channel and picture shape)
 *               - animFrameSvg({ platform, t, layout }): one frame
 *               - soundFilters(taps, start): ffmpeg audio sources for the sounds
 * Dependencies: none.
 */

export const ANIM_SEC = 5.6;
export const ANIM_FPS = 30;
export const ANIM_MIN_VIDEO_SEC = 180;
export const ANIM_LEAD_SEC = 10;

const TAP = { like: 0.8, button: 1.7, bell: 2.6 };

/** Each channel's own look: like icon, button words and colours, bell or not. */
export const ANIM_STYLES = {
  youtube: { like: 'thumb', likeOn: '#3EA6FF', button: 'SUBSCRIBE', done: 'SUBSCRIBED', color: '#E62117', doneColor: '#606060', ink: '#FFFFFF', bell: true },
  instagram: { like: 'heart', likeOn: '#FF3040', button: 'Follow', done: 'Following', color: '#0095F6', doneColor: '#363636', ink: '#FFFFFF', bell: true },
  facebook: { like: 'thumb', likeOn: '#1877F2', button: 'Follow', done: 'Following', color: '#1877F2', doneColor: '#3A3B3C', ink: '#FFFFFF', bell: true },
  tiktok: { like: 'heart', likeOn: '#FE2C55', button: 'Follow', done: 'Following', color: '#FE2C55', doneColor: '#3A3A3A', ink: '#FFFFFF', bell: false },
  linkedin: { like: 'thumb', likeOn: '#378FE9', button: '+ Follow', done: 'Following', color: '#0A66C2', doneColor: '#3A3A3A', ink: '#FFFFFF', bell: true },
  threads: { like: 'heart', likeOn: '#FF3040', button: 'Follow', done: 'Following', color: '#FFFFFF', doneColor: '#3A3A3A', ink: '#000000', bell: false },
  x: { like: 'heart', likeOn: '#F91880', button: 'Follow', done: 'Following', color: '#FFFFFF', doneColor: '#3A3A3A', ink: '#000000', bell: true },
};

export const styleFor = (platform) => ANIM_STYLES[platform] || ANIM_STYLES.instagram;

/** Plays 10 s before the text line, on videos over 3 minutes; null otherwise. */
export function animWindow(totalSec, textStart) {
  const d = Number(totalSec) || 0;
  const s = Number(textStart);
  if (d <= ANIM_MIN_VIDEO_SEC || !Number.isFinite(s)) return null;
  const start = Math.round((s - ANIM_LEAD_SEC) * 10) / 10;
  if (start < 2) return null;
  return { start, end: Math.round((start + ANIM_SEC) * 10) / 10 };
}

/** The taps inside the animation, with their sound. */
export function animTaps(platform) {
  const st = styleFor(platform);
  return [
    { at: TAP.like, sound: 'click' },
    { at: TAP.button, sound: 'click' },
    ...(st.bell ? [{ at: TAP.bell, sound: 'bell' }] : []),
  ];
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const r1 = (n) => Math.round(n * 10) / 10;

/** Row geometry in units of `u` (the row height). */
function rowUnits(st) {
  const label = Math.max(st.button.length, st.done.length);
  const bw = label * 0.3 * 0.64 + 0.62;
  const pad = 0.2;
  const items = [{ kind: 'like', w: 0.62 }, { kind: 'button', w: bw }, ...(st.bell ? [{ kind: 'bell', w: 0.62 }] : [])];
  const gap = 0.24;
  const width = pad * 2 + items.reduce((n, it) => n + it.w, 0) + gap * (items.length - 1);
  return { items, gap, pad, width, bw };
}

/**
 * Where the animation sits: tall videos (Reels, Shorts, TikTok) in the upper
 * middle, clear of the right-hand buttons and the caption at the bottom; 4:5
 * a little higher; wide videos (YouTube long form, X) bottom left.
 */
export function animLayout({ w = 1080, h = 1920, platform = '' } = {}) {
  const W = even(Number(w) || 1080);
  const H = even(Number(h) || 1920);
  const st = styleFor(platform);
  const units = rowUnits(st);
  const tall = H >= W * 1.2;
  const portrait = H > W;
  let u = tall ? W * 0.13 : portrait ? W * 0.11 : H * 0.1;
  const boxPadX = 0.12;
  u = Math.min(u, (W * 0.94) / (units.width + boxPadX * 2));
  const boxW = even(u * (units.width + boxPadX * 2));
  const boxH = even(u * 1.3);
  const x = tall || portrait ? even((W - boxW) / 2) : even(W * 0.04);
  const y = tall ? even(H * 0.19) : portrait ? even(H * 0.1) : even(H * 0.68);
  return { W, H, u: r1(u), boxW, boxH, x, y, units, boxPadX };
}

const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => { const x = clamp(v); return x * x * (3 - 2 * x); };
const bump = (t, at, len = 0.3) => (t >= at && t <= at + len ? Math.sin((Math.PI * (t - at)) / len) : 0);
const lerp = (a, b, k) => a + (b - a) * k;

const THUMB = 'M2 10h4v11H2z M8 10l4-7c1-1.2 3-0.5 3 1.5L14 9h6c1.4 0 2.3 1.4 1.9 2.7l-2.1 7.3c-0.3 1.2-1.4 2-2.6 2H8z';
const HEART = 'M12 21s-9-6-9-12.2C3 6 5.2 4 7.8 4c1.8 0 3.2 1 4.2 2.5C13 5 14.4 4 16.2 4 18.8 4 21 6 21 8.8 21 15 12 21 12 21z';
const BELL = 'M12 3c-3.3 0-5 2.6-5 5.5V13l-2 3v1h14v-1l-2-3V8.5C17 5.6 15.3 3 12 3z';
const CURSOR = 'M0 0v16l4.5-4 3 7 2.5-1-3-7h6z';

/** Centre x of each item, in pixels from the box's left. */
function itemCentres(layout) {
  const { u, units, boxPadX } = layout;
  let x = (boxPadX + units.pad) * u;
  const out = {};
  for (const it of units.items) {
    out[it.kind] = x + (it.w * u) / 2;
    x += (it.w + units.gap) * u;
  }
  return out;
}

/** The cursor's tip at time t: in from the lower right, to each item in turn, then away. */
function cursorAt(t, layout, centres, st) {
  const { boxW, boxH, u } = layout;
  const cy = boxH / 2 + 0.08 * u;
  const off = { x: boxW - 0.25 * u, y: boxH - 0.42 * u };
  const stops = [
    { at: 0.35, ...off },
    { at: TAP.like - 0.05, x: centres.like + 0.06 * u, y: cy },
    { at: TAP.button - 0.1, x: centres.button + 0.1 * u, y: cy },
    ...(st.bell ? [{ at: TAP.bell - 0.1, x: centres.bell + 0.06 * u, y: cy }] : []),
  ];
  const lastTap = st.bell ? TAP.bell : TAP.button;
  stops.push({ at: lastTap + 0.45, x: stops[stops.length - 1].x, y: stops[stops.length - 1].y });
  stops.push({ at: lastTap + 1.0, ...off });
  if (t <= stops[0].at) return { ...off, o: clamp(t / 0.35) };
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i].at) {
      const k = ease((t - stops[i - 1].at) / (stops[i].at - stops[i - 1].at));
      return { x: lerp(stops[i - 1].x, stops[i].x, k), y: lerp(stops[i - 1].y, stops[i].y, k), o: 1 };
    }
  }
  return { ...off, o: 1 - clamp((t - stops[stops.length - 1].at) / 0.3) };
}

/** One frame of the animation, `t` seconds in, as an SVG the size of its box. */
export function animFrameSvg({ platform = '', t = 0, layout }) {
  const st = styleFor(platform);
  const L = layout || animLayout({ platform });
  const { boxW, boxH, u } = L;
  const appear = ease(t / 0.45);
  const leave = ease((t - (ANIM_SEC - 0.6)) / 0.55);
  const opacity = r1(appear * (1 - leave) * 100) / 100;
  if (opacity <= 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}"></svg>`;
  const dy = r1((1 - appear) * 0.35 * u - leave * 0.3 * u + Math.sin(t * 2.4) * 0.025 * u);
  const c = itemCentres(L);
  const cy = boxH / 2;
  const icon = 0.62 * u;
  const font = 'font-family="Noto Sans, DejaVu Sans, sans-serif"';
  const parts = [];
  const panelH = 0.9 * u;
  parts.push(`<rect x="${r1(L.boxPadX * u)}" y="${r1(cy - panelH / 2)}" width="${r1(L.units.width * u)}" height="${r1(panelH)}" rx="${r1(panelH / 2)}" fill="#000000" fill-opacity="0.5"/>`);

  // Like: pops and fills on its tap.
  const liked = t >= TAP.like;
  const ls = 1 + 0.35 * bump(t, TAP.like);
  const lk = (icon / 24) * ls;
  const likePath = st.like === 'heart' ? HEART : THUMB;
  parts.push(`<g transform="translate(${r1(c.like - 12 * lk)} ${r1(cy - 12 * lk)}) scale(${Math.round(lk * 1000) / 1000})"><path d="${likePath}" fill="${liked ? st.likeOn : 'none'}" stroke="${liked ? st.likeOn : '#FFFFFF'}" stroke-width="2" stroke-linejoin="round"/></g>`);

  // Button: turns to its done words on its tap.
  const done = t >= TAP.button;
  const bs = 1 + 0.12 * bump(t, TAP.button);
  const bw = L.units.bw * u * bs;
  const bh = 0.56 * u * bs;
  const fill = done ? st.doneColor : st.color;
  const ink = done ? '#FFFFFF' : st.ink;
  parts.push(`<rect x="${r1(c.button - bw / 2)}" y="${r1(cy - bh / 2)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(bh / 2)}" fill="${fill}"/>`);
  parts.push(`<text x="${r1(c.button)}" y="${r1(cy + 0.105 * u * bs)}" text-anchor="middle" ${font} font-weight="700" font-size="${r1(0.3 * u * bs)}" fill="${ink}">${done ? st.done : st.button}</text>`);

  // Bell: swings, dying away, after its tap.
  if (st.bell) {
    const since = t - TAP.bell;
    const angle = since > 0 ? r1(24 * Math.sin(2 * Math.PI * 3.2 * since) * Math.exp(-2.2 * since)) : 0;
    const bk = icon / 24;
    const rung = since > 0;
    parts.push(`<g transform="translate(${r1(c.bell)} ${r1(cy - 12 * bk)}) rotate(${angle}) translate(${r1(-12 * bk)} 0) scale(${Math.round(bk * 1000) / 1000})"><path d="${BELL}" fill="${rung ? '#FFFFFF' : 'none'}" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="19.6" r="1.8" fill="#FFFFFF"/></g>`);
  }

  // A ring spreads from each tap.
  for (const tap of animTaps(platform)) {
    const k = (t - tap.at) / 0.4;
    if (k < 0 || k > 1) continue;
    const at = tap.at === TAP.like ? c.like : tap.at === TAP.button ? c.button : c.bell;
    parts.push(`<circle cx="${r1(at)}" cy="${r1(cy)}" r="${r1(0.15 * u + k * 0.45 * u)}" fill="none" stroke="#FFFFFF" stroke-width="${r1(0.04 * u)}" stroke-opacity="${r1((1 - k) * 0.7 * 100) / 100}"/>`);
  }

  // The cursor, pressed down a little on each tap.
  const cur = cursorAt(t, L, c, st);
  const pressed = animTaps(platform).some((tap) => t >= tap.at - 0.05 && t <= tap.at + 0.1);
  const ck = ((0.42 * u) / 19) * (pressed ? 0.86 : 1);
  if (cur.o > 0) {
    parts.push(`<g opacity="${r1(cur.o * 100) / 100}" transform="translate(${r1(cur.x)} ${r1(cur.y)}) scale(${Math.round(ck * 1000) / 1000})"><path d="${CURSOR}" fill="#FFFFFF" stroke="#111111" stroke-width="1.2" stroke-linejoin="round"/></g>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}"><g opacity="${opacity}" transform="translate(0 ${dy})">${parts.join('')}</g></svg>`;
}

/** Click: a short bright tick. Bell: a bright ding dying away. Both made by ffmpeg, no sound files. */
const SOUND = {
  click: { d: 0.07, expr: '0.55*sin(2*PI*3200*t)*exp(-110*t)+0.35*sin(2*PI*1250*t)*exp(-70*t)' },
  bell: { d: 1.5, expr: '0.2*(sin(2*PI*1568*t)+0.6*sin(2*PI*2349*t)+0.4*sin(2*PI*3136*t)+0.25*sin(2*PI*4186*t))*exp(-3.2*t)' },
};

/**
 * One ffmpeg filter chain per tap sound, delayed to its moment and padded to
 * the video's length, labelled [s0], [s1], ...
 */
export function soundFilters(taps = [], start = 0) {
  return taps.map((tap, i) => {
    const s = SOUND[tap.sound] || SOUND.click;
    const ms = Math.max(0, Math.round((Number(start) + tap.at) * 1000));
    return `aevalsrc='${s.expr}':s=48000:d=${s.d},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=delays=${ms}:all=1,apad[s${i}]`;
  });
}

export default {
  ANIM_SEC, ANIM_FPS, ANIM_MIN_VIDEO_SEC, ANIM_LEAD_SEC, ANIM_STYLES, styleFor, animWindow, animTaps, animLayout, animFrameSvg, soundFilters,
};
