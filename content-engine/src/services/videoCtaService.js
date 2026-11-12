/**
 * On-video call to action per channel.
 *
 * Purpose:      Before a video is posted, burn each channel's call to action
 *               (Subscribe, Follow, DM: Settings > Call to action on the video)
 *               into the middle of its own copy. On videos over 3 minutes a
 *               floating like / follow / bell animation with click and bell
 *               sounds plays 10 s before the line, in each channel's own look.
 *               The video keeps playing throughout; nothing is spoken. Copies
 *               that would be identical are rendered once. Each video takes the
 *               next line in turn (a counter per workspace). A render that
 *               fails leaves that channel on the original video: the post
 *               always goes out.
 * Responsibility:
 *               - addChannelCta({ tenantId, resolved, videoUrls, durationSec,
 *                   platformConfigurations, publish, log })
 *                 => { platformConfigurations, cta: { turn, sec, texts, anim, done, errors } | null }
 *               - reapplyCta({ ..., cta }): the same lines on a new source
 *                 (a scheduled post fixed with Clean)
 *               - previewCta({ platform, line, animated }): a short test clip
 *                 rendered by this server's ffmpeg (Settings ▶ Preview)
 * Dependencies: utils/ctaSpec, utils/ctaAnimSpec, providers/ffmpegProvider,
 *               sharp, repositories/tenantConfigRepository.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { normalizeVideoCta, ctaPlan, ctaWindow, ctaBannerSvg, ctaOverlayArgs, videoPlatforms, withCtaVideos, renderGroups, ctaLines, CTA_PLATFORMS } from '../utils/ctaSpec.js';
import { animWindow, animLayout, animFrameSvg, animTaps, soundFilters, ANIM_SEC, ANIM_FPS } from '../utils/ctaAnimSpec.js';

const TURN_KEY = 'video_cta_turn';
const run = promisify(execFile);

/** This video's turn, and the counter moved on for the next one. */
async function nextTurn(tenantId) {
  const n = Number((await tenantConfig.get(tenantId, TURN_KEY).catch(() => null)) || 0);
  const turn = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  await tenantConfig.set(tenantId, TURN_KEY, String(turn + 1)).catch(() => {});
  return turn;
}

/** The animation's frames as numbered PNGs in `dir`; returns the ffmpeg input pattern. */
async function writeFrames(dir, platform, layout) {
  await mkdir(dir, { recursive: true });
  const count = Math.ceil(ANIM_SEC * ANIM_FPS);
  for (let i = 0; i < count; i += 1) {
    const svg = animFrameSvg({ platform, t: i / ANIM_FPS, layout });
    await writeFile(join(dir, `f${String(i).padStart(4, '0')}.png`), await sharp(Buffer.from(svg)).png().toBuffer());
  }
  return join(dir, 'f%04d.png');
}

/**
 * One copy: the text line (and the animation when `animate`) burned into
 * `source`, written to `output`. Window times can be forced (preview).
 */
async function renderCopy({ ffmpeg, dir, idx, source, info, total, text, look, sec, animate, output, force = null }) {
  const w = info.width || 1080;
  const h = info.height || 1920;
  const win = force ? force.text : ctaWindow(total, sec);
  if (!win) throw new Error(`video too short for a ${sec} s call to action`);
  const overlay = join(dir, `pill${idx}.png`);
  await writeFile(overlay, await sharp(Buffer.from(ctaBannerSvg({ w, h, text, platform: look }))).png().toBuffer());
  const aw = animate ? (force ? force.anim : animWindow(total, win.start)) : null;
  let anim = null;
  if (aw) {
    const layout = animLayout({ w, h, platform: look });
    const pattern = await writeFrames(join(dir, `anim${idx}`), look, layout);
    anim = { pattern, start: aw.start, x: layout.x, y: layout.y, fps: ANIM_FPS, sounds: soundFilters(animTaps(look), aw.start) };
  }
  await ffmpeg.overlayCta({ args: ctaOverlayArgs({ input: source, overlay, output, start: win.start, end: win.end, fps: info.fps || 30, anim, hasAudio: info.hasAudio !== false, totalSec: total }) });
  return { animated: !!anim };
}

/** Render every group; returns { urlByPlatform, animated, errors }. */
async function renderAll({ groups, durationSec, sec, animate, publish, log }) {
  const ffmpeg = createFfmpegProvider({}, log);
  const urlByPlatform = {};
  const errors = [];
  let animated = false;
  const probed = new Map();
  const dir = await mkdtemp(join(tmpdir(), 'cta-'));
  try {
    let idx = 0;
    for (const g of groups.values()) {
      idx += 1;
      const t0 = Date.now();
      try {
        if (!probed.has(g.source)) {
          const info = await ffmpeg.probeVideo({ url: g.source });
          const total = (await ffmpeg.probeDuration({ url: g.source })) || Number(durationSec) || 0;
          probed.set(g.source, { info, total });
        }
        const { info, total } = probed.get(g.source);
        const output = join(dir, `cta${idx}.mp4`);
        const r = await renderCopy({ ffmpeg, dir, idx, source: g.source, info, total, text: g.text, look: g.look, sec, animate, output });
        animated = animated || r.animated;
        const url = await publish.uploadFile(output, 'video/mp4');
        for (const p of g.platforms) urlByPlatform[p] = url;
        await rm(output, { force: true }).catch(() => {});
        await rm(join(dir, `anim${idx}`), { recursive: true, force: true }).catch(() => {});
        log?.info?.({ text: g.text, platforms: g.platforms, animated: r.animated, seconds: Math.round((Date.now() - t0) / 1000) }, 'call to action rendered');
      } catch (err) {
        errors.push(`${g.platforms.join(', ')}: ${String(err.message).slice(0, 160)}`);
        log?.warn?.({ err: err.message, text: g.text, platforms: g.platforms }, 'call to action render failed (that channel posts the original)');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { urlByPlatform, animated, errors };
}

/**
 * Give each channel posting one of `videoUrls` its own copy with its call to
 * action. Off, or no channel posts a video: the configs come back unchanged.
 */
export async function addChannelCta({ tenantId, resolved = {}, videoUrls = [], durationSec = 0, platformConfigurations, publish, log }) {
  const set = normalizeVideoCta(resolved.videoCta);
  const sources = videoPlatforms(platformConfigurations, videoUrls);
  const platforms = Object.keys(sources);
  if (!set.on || !platforms.length) return { platformConfigurations, cta: null };
  const turn = await nextTurn(tenantId);
  const plan = ctaPlan({ platforms, lists: set.lists, turn });
  const animate = Number(durationSec) > 180;
  try {
    const groups = renderGroups({ sources, plan, animated: animate });
    const { urlByPlatform, animated, errors } = await renderAll({ groups, durationSec, sec: set.sec, animate, publish, log });
    return {
      platformConfigurations: withCtaVideos(platformConfigurations, urlByPlatform),
      cta: { turn, sec: set.sec, texts: plan, anim: animated, done: Object.keys(urlByPlatform), errors },
    };
  } catch (err) {
    log?.warn?.({ err: err.message }, 'call to action skipped (posted without it)');
    return { platformConfigurations, cta: { turn, sec: set.sec, texts: plan, anim: false, done: [], errors: [String(err.message).slice(0, 200)] } };
  }
}

/**
 * The same lines again on a new source video (a scheduled post fixed with
 * Clean): `platformConfigurations` already point at `videoUrl`.
 */
export async function reapplyCta({ videoUrl, durationSec = 0, platformConfigurations, cta, publish, log }) {
  if (!cta || !cta.texts) return { platformConfigurations, cta };
  const all = videoPlatforms(platformConfigurations, [videoUrl]);
  const sources = Object.fromEntries(Object.entries(all).filter(([p]) => cta.texts[p]));
  if (!Object.keys(sources).length) return { platformConfigurations, cta };
  const animate = Number(durationSec) > 180;
  try {
    const groups = renderGroups({ sources, plan: cta.texts, animated: animate });
    const { urlByPlatform, animated, errors } = await renderAll({ groups, durationSec, sec: cta.sec || 4, animate, publish, log });
    return { platformConfigurations: withCtaVideos(platformConfigurations, urlByPlatform), cta: { ...cta, anim: animated, done: Object.keys(urlByPlatform), errors } };
  } catch (err) {
    log?.warn?.({ err: err.message }, 'call to action not redone (fixed post goes without it)');
    return { platformConfigurations, cta: { ...cta, done: [], errors: [String(err.message).slice(0, 200)] } };
  }
}

/**
 * ▶ Preview: a 14 s test clip (moving test picture, a tone for sound) with the
 * channel's animation at 1.5 s and its line at 8 s, rendered by this server's
 * own ffmpeg exactly as a real post would be. Returns the mp4 bytes.
 */
export async function previewCta({ platform = 'youtube', line = '', animated = true, wide = false, log } = {}) {
  const p = CTA_PLATFORMS.includes(platform) ? platform : 'youtube';
  const text = ctaLines(line, p)[0];
  const ffmpeg = createFfmpegProvider({}, log);
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const dir = await mkdtemp(join(tmpdir(), 'ctaprev-'));
  try {
    const size = wide ? '960x540' : '540x960';
    const source = join(dir, 'src.mp4');
    await run(bin, ['-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=14`, '-f', 'lavfi', '-i', 'sine=frequency=220:d=14', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', source], { timeout: 120000 });
    const [w, h] = size.split('x').map(Number);
    const output = join(dir, 'preview.mp4');
    await renderCopy({
      ffmpeg, dir, idx: 1, source, info: { width: w, height: h, fps: 30, hasAudio: true }, total: 14, text, look: p, sec: 4, animate: animated, output,
      force: { text: { start: 8, end: 12 }, anim: { start: 1.5, end: 1.5 + ANIM_SEC } },
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export default { addChannelCta, reapplyCta, previewCta };
