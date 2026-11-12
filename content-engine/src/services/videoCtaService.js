/**
 * On-video call to action per channel.
 *
 * Purpose:      Before a ready video is posted, burn each channel's call to
 *               action (Subscribe, Follow, DM: Settings > Call to action on the
 *               video) into the middle of the video, and give every channel its
 *               own copy. Channels whose line is the same share one copy. Each
 *               video takes the next line in turn (a counter per workspace).
 *               A render that fails leaves that channel on the original video:
 *               the post always goes out.
 * Responsibility:
 *               - addChannelCta({ tenantId, resolved, videoUrl, durationSec,
 *                   platformConfigurations, publish, log })
 *                 => { platformConfigurations, cta: { turn, texts, errors } | null }
 *               - reapplyCta({ ... , texts }): the same lines on a new source
 *                 (a scheduled post fixed with Clean)
 * Dependencies: utils/ctaSpec, providers/ffmpegProvider, sharp,
 *               repositories/tenantConfigRepository.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { normalizeVideoCta, ctaPlan, ctaGroups, ctaWindow, ctaBannerSvg, ctaOverlayArgs, videoPlatforms, withCtaVideos } from '../utils/ctaSpec.js';

const TURN_KEY = 'video_cta_turn';

/** This video's turn, and the counter moved on for the next one. */
async function nextTurn(tenantId) {
  const raw = await tenantConfig.get(tenantId, TURN_KEY).catch(() => null);
  const n = Number((raw && typeof raw === 'object' ? raw.value : raw) || 0);
  const turn = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  await tenantConfig.set(tenantId, TURN_KEY, String(turn + 1)).catch(() => {});
  return turn;
}

/** Render one copy per distinct line; returns { urlByPlatform, errors }. */
async function render({ videoUrl, durationSec, sec, plan, publish, log }) {
  const ffmpeg = createFfmpegProvider({}, log);
  const info = await ffmpeg.probeVideo({ url: videoUrl });
  const total = Number(durationSec) || (await ffmpeg.probeDuration({ url: videoUrl }));
  const win = ctaWindow(total, sec);
  if (!win) return { urlByPlatform: {}, errors: [`video too short for a ${sec} s call to action`] };
  const w = info.width || 1080;
  const h = info.height || 1920;
  const urlByPlatform = {};
  const errors = [];
  const dir = await mkdtemp(join(tmpdir(), 'cta-'));
  try {
    let i = 0;
    for (const [text, platforms] of ctaGroups(plan)) {
      i += 1;
      const t0 = Date.now();
      try {
        const overlay = join(dir, `cta${i}.png`);
        const output = join(dir, `cta${i}.mp4`);
        const look = platforms.includes('youtube') && platforms.length === 1 ? 'youtube' : platforms[0];
        await writeFile(overlay, await sharp(Buffer.from(ctaBannerSvg({ w, h, text, platform: look }))).png().toBuffer());
        await ffmpeg.overlayCta({ args: ctaOverlayArgs({ input: videoUrl, overlay, output, start: win.start, end: win.end, fps: info.fps || 30 }) });
        const url = await publish.uploadFile(output, 'video/mp4');
        for (const p of platforms) urlByPlatform[p] = url;
        await rm(output, { force: true }).catch(() => {});
        log?.info?.({ text, platforms, seconds: Math.round((Date.now() - t0) / 1000) }, 'call to action rendered');
      } catch (err) {
        errors.push(`${platforms.join(', ')}: ${String(err.message).slice(0, 160)}`);
        log?.warn?.({ err: err.message, text, platforms }, 'call to action render failed (that channel posts the original)');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { urlByPlatform, errors };
}

/**
 * Give each channel posting `videoUrl` its own copy with its call to action.
 * Off, or no channel posts the video: the configs come back unchanged.
 */
export async function addChannelCta({ tenantId, resolved = {}, videoUrl, durationSec = 0, platformConfigurations, publish, log }) {
  const set = normalizeVideoCta(resolved.videoCta);
  const platforms = videoPlatforms(platformConfigurations, videoUrl);
  if (!set.on || !platforms.length) return { platformConfigurations, cta: null };
  const turn = await nextTurn(tenantId);
  const plan = ctaPlan({ platforms, lists: set.lists, turn });
  try {
    const { urlByPlatform, errors } = await render({ videoUrl, durationSec, sec: set.sec, plan, publish, log });
    return {
      platformConfigurations: withCtaVideos(platformConfigurations, videoUrl, urlByPlatform),
      cta: { turn, sec: set.sec, texts: plan, done: Object.keys(urlByPlatform), errors },
    };
  } catch (err) {
    log?.warn?.({ err: err.message }, 'call to action skipped (posted without it)');
    return { platformConfigurations, cta: { turn, sec: set.sec, texts: plan, done: [], errors: [String(err.message).slice(0, 200)] } };
  }
}

/**
 * The same lines again on a new source video (a scheduled post fixed with
 * Clean): `configs` already point at `videoUrl`, `cta` is what was saved.
 */
export async function reapplyCta({ videoUrl, durationSec = 0, platformConfigurations, cta, publish, log }) {
  if (!cta || !cta.texts) return { platformConfigurations, cta };
  const platforms = videoPlatforms(platformConfigurations, videoUrl);
  const plan = Object.fromEntries(platforms.filter((p) => cta.texts[p]).map((p) => [p, cta.texts[p]]));
  if (!Object.keys(plan).length) return { platformConfigurations, cta };
  try {
    const { urlByPlatform, errors } = await render({ videoUrl, durationSec, sec: cta.sec || 4, plan, publish, log });
    return { platformConfigurations: withCtaVideos(platformConfigurations, videoUrl, urlByPlatform), cta: { ...cta, done: Object.keys(urlByPlatform), errors } };
  } catch (err) {
    log?.warn?.({ err: err.message }, 'call to action not redone (fixed post goes without it)');
    return { platformConfigurations, cta: { ...cta, done: [], errors: [String(err.message).slice(0, 200)] } };
  }
}

export default { addChannelCta, reapplyCta };
