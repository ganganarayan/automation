/**
 * Daily router: Lane 3: the image post (fail-safe).
 *
 * Purpose:      When no video lane delivers a funnel's post, line up an image
 *               post from the funnel's sheet as an INSTANCE, so it goes through
 *               the same instance → Post for Me → post check
 *               path as every other lane (docs/daily-router-plan.md, Lane 3).
 * Responsibility:
 *               - prepare: top the sheet up (fewer than 2 Ready rows → 7 new
 *                 rows from the landing page + post history), pick the next
 *                 Ready row no open instance holds, create the instance
 *                 (source_type 'sheet', source_ref = the row's key), generate
 *                 the image, open the approval (the daily email carries the link).
 *               - approve: sheet row → Approved; ONE Post for Me post to all
 *                 the funnel's accounts at scheduled_for, or at once if that
 *                 has passed (D2); first comment + webhook; instance → scheduled.
 *               - rework: regenerate the image with the note, re-send approval.
 *               - onPosted: the post check found it live → sheet row Posted +
 *                 the Post for Me post id.
 *               - stepDown: a Lane 2 video whose animation failed becomes an image
 *                 post on its own instance, from its own still (utils/stepDownSpec).
 * Dependencies: funnelPosterService (sheet tab, image generation, approval
 *               email, sheet writes, capture/IG extras), approvalService,
 *               instanceService/instanceRepository, providerFactory,
 *               publishProvider, firstCommentService, imageComposer, utils/{routerSpec,
 *               postCompose,instanceSpec,pricing,stepDownSpec,time}, httpClient.
 *
 * Instance statuses: running (image being made) → image_review (approval link
 * out) → approved → scheduled → posted | partial | failed.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as instanceService from './instanceService.js';
import * as approvalService from './approvalService.js';
import * as stepLog from './stepLogService.js';
import { setStatus as setApprovalStatus } from '../repositories/approvalRepository.js';
import * as poster from './funnelPosterService.js';
import * as firstComment from './firstCommentService.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { request } from '../core/httpClient.js';
import { extractRow, composePrompt, composeCaptions, buildPlatformConfigs } from '../utils/postCompose.js';
import { patchStep, addCostToSteps, sumInstanceCost } from '../utils/instanceSpec.js';
import * as imageShort from './imageShortService.js';
import {
  shortTitle, photoSubMargins, imageVideoMode, imageVideoConfigs, IMAGE_VIDEO_SIZES, sizedPrompt, sizesNeeded, videoRunner, otherRunner, failSafeOn, withMusicCredit,
} from '../utils/shortSpec.js';
import * as imageVideoJob from './imageVideoJobService.js';
import { settings } from '../settings/index.js';
import { imageSpec } from '../utils/imageGateSpec.js';
import { platformKey } from '../utils/aiCopySpec.js';
import { createTtsProvider } from '../providers/ttsProvider.js';
import { costImages, costAnimation, costTts } from '../utils/pricing.js';
import { totalClipSeconds } from '../utils/stageSpec.js';
import { stepDownOf, stepDownPicture, stepDownText, stepDownCaption, stepDownPrompt, stepDownNote } from '../utils/stepDownSpec.js';
import { headlineImage } from './imageComposer.js';
import { formatIst } from '../utils/time.js';
import { festivalCaptions } from '../utils/festivalSpec.js';
import {
  IMAGE_REVIEW, REFILL_BELOW, REFILL_COUNT, PFM_COL, LINKS_COL, SOURCE_COL, SHEET_STATUS,
  CELL_NEWLINE, postedLinks, imageAccounts,
  readyRows, pickReadyRow, planHeader, colLetter, nextMatchKeys, htmlToText, landingUrls, historyLines,
  instanceHistoryLine, sheetHistory, sheetColumns, refillPrompt, normalizeRefill, rowsForSheet, postAtFor,
} from '../utils/routerSpec.js';
import { childLogger } from '../core/logger.js';

export const KIND = 'image_post';

const baseLog = childLogger({ module: 'imageLane' });

/** A reason the lane could not line up a post (shown on router_days.reason). */
export class LaneError extends Error {}

const art = (steps, k) => ((steps.find((s) => s.key === k) || {}).artifacts) || {};

/**
 * The funnel's landing page(s) as plain text ('' when unset or unreachable),
 * one block per page, about 6000 characters shared between them. Lane 2
 * research uses it too.
 */
export async function landingText(raw, log) {
  const urls = landingUrls(raw);
  if (!urls.length) return '';
  const cap = Math.max(1500, Math.floor(6000 / urls.length));
  const pages = await Promise.all(urls.map(async (url) => {
    try {
      const res = await request(url, { label: 'landing.page', log, retries: 0, timeoutMs: 15000, headers: { Accept: 'text/html' } });
      return res.ok ? htmlToText(res.text, cap) : '';
    } catch (err) {
      log.warn({ err: err.message, url }, 'landing page fetch failed (researching without it)');
      return '';
    }
  }));
  if (urls.length === 1) return pages[0];
  return urls.map((u, i) => (pages[i] ? `[${u}]\n${pages[i]}` : '')).filter(Boolean).join('\n\n');
}

/**
 * Write REFILL_COUNT new Ready rows (source = Auto) researched from the
 * funnel's landing page and post history. Returns the sheet re-read.
 */
async function refill({ f, providers, tab, rows, log }) {
  const [page, recent] = await Promise.all([
    landingText(f.landingPageUrl, log),
    instanceRepo.recentForFunnel(f.id, f.tenantId, 40).catch(() => []),
  ]);
  const history = historyLines([...recent.map(instanceHistoryLine), ...sheetHistory(rows)], 60);
  const examples = rows.slice(1).map((r) => extractRow(rows[0], r || []).imagePrompt).filter(Boolean).slice(-3);
  const { system, user } = refillPrompt({
    funnelName: f.name, landingUrl: f.landingPageUrl, landingText: page, history, examples,
    columns: sheetColumns(rows[0]), count: REFILL_COUNT,
  });
  const posts = normalizeRefill(await providers.llm.generateJson({ system, user, maxTokens: 8000 }), REFILL_COUNT);
  if (!posts.length) throw new Error('the AI wrote no usable rows');
  const plan = planHeader(rows[0], [SOURCE_COL]);
  for (const a of plan.added) await providers.sheets.updateCells(f.sheetId, `${tab}!${colLetter(a.index)}1`, [[a.name]]);
  await providers.sheets.appendRows(f.sheetId, tab, rowsForSheet(plan.header, posts, nextMatchKeys(rows, posts.length)));
  log.info({ added: posts.length, landing: !!page, history: history.length }, 'image sheet topped up');
  return providers.sheets.readTab(f.sheetId, tab, { fresh: true });
}

/**
 * Make an instance's post and send the approval: the pictures, and in video
 * mode (the default) the voice, subtitles and one video per size, all before
 * the approval opens, so what you approve is what goes out. The whole job runs
 * in ONE place: GitHub Actions or Railway (Settings, image_video_runner); if
 * it fails there and the fail-safe is on, the other place does it all again.
 * GitHub answers later through imageVideoJobService's hooks; Railway answers
 * now. Leaves the instance at image_review (or failed, with the reason).
 */
async function renderAndSend({ instanceId, f, providers, fields, sheet, note = '', festival = null, log }) {
  const inst = await instanceRepo.get(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  // A festival post is your own picture and your own words: nothing is drawn or rewritten.
  const { full, short } = festival ? festivalCaptions(festival.copy) : composeCaptions(fields, { ctaLink: f.ctaLink, audiencePrefix: f.audiencePrefix });
  const prompt = festival ? '' : composePrompt(fields, note);
  // Everything a runner needs is saved first, so a fail-safe can start over from the instance.
  let steps = instanceService.parseSteps(inst);
  for (const k of ['animate', 'voiceover', 'transcript', 'stitch']) steps = patchStep(steps, k, { status: 'skipped' });
  steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: short || full, copy: { title: fields.headline || '', description: full }, captionFull: full, captionShort: short } });
  steps = patchStep(steps, 'images', { status: 'running', startedAt: new Date().toISOString(), artifacts: { prompt, note: note || '', row: fields, sheet, tried: [], ...(festival ? { festival } : {}) } });
  await instanceRepo.saveSteps(instanceId, steps, sumInstanceCost(steps));
  await stepLog.start(instanceId, 'images');
  const video = imageVideoMode(providers.resolved.imageVideo) === 'on';
  const runner = video ? videoRunner(providers.resolved.imageVideoRunner) : 'railway';
  await makeWith(runner, { instanceId, f, providers, video, log });
  return null;
}

/** Run the whole job in `runner`; on failure, the fail-safe (or the instance fails and this throws). */
async function makeWith(runner, ctx) {
  const { instanceId, log } = ctx;
  await markTried(instanceId, runner);
  try {
    if (runner === 'github') await startOnGithub(ctx);
    else await makeOnRailway(ctx);
  } catch (err) {
    await fallBack(instanceId, runner, err.message, ctx.providers, log);
  }
}

async function markTried(instanceId, runner) {
  const inst = await instanceRepo.get(instanceId);
  const img = art(instanceService.parseSteps(inst), 'images');
  const tried = [...new Set([...(img.tried || []), runner])];
  await instanceService.updateStep(instanceId, 'images', { artifacts: { ...img, tried, runner } });
}

/** The runner failed: the other one does it all, once, when the fail-safe is on; else the instance fails. */
async function fallBack(instanceId, runner, error, providers, log) {
  const inst = await instanceRepo.get(instanceId);
  const img = art(instanceService.parseSteps(inst), 'images');
  const other = otherRunner(runner);
  log.warn({ instance: instanceId, runner, err: error }, 'image-post video failed');
  if (imageVideoMode(providers.resolved.imageVideo) === 'on' && failSafeOn(providers.resolved.imageVideoFailSafe) && !(img.tried || []).includes(other)) {
    log.info({ instance: instanceId, from: runner, to: other }, 'fail-safe: the other place makes it');
    const ctx = await contextOf(inst, log);
    if (ctx) return makeWith(other, ctx);
  }
  await stepLog.fail(instanceId, 'images');
  await instanceService.updateStep(instanceId, 'images', { status: 'failed', error: String(error).slice(0, 300) });
  const where = runner === 'github' ? 'GitHub' : 'Railway';
  await instanceRepo.setStatus(instanceId, 'failed', `Video not made on ${where}: ${String(error).slice(0, 300)}`);
  throw new Error(`video not made on ${where}: ${error}`);
}

/** Rebuild a runner's context from the instance alone (hooks and timeouts arrive with only its id). */
async function contextOf(inst, log) {
  const funnelRow = inst && inst.funnel_id ? await funnels.get(inst.funnel_id) : null;
  if (!funnelRow) return null;
  const f = await funnels.resolve(funnelRow);
  const providers = await buildProviders(f.tenantId);
  return { instanceId: inst.id, f, providers, video: imageVideoMode(providers.resolved.imageVideo) === 'on', log };
}

/** Hand the whole job to GitHub; its done hook continues in githubDone. */
async function startOnGithub({ instanceId, f, providers }) {
  const inst = await instanceRepo.get(instanceId);
  const steps = instanceService.parseSteps(inst);
  const img = art(steps, 'images');
  const script = art(steps, 'script');
  const cfg = await funnels.getConfig(f.id).catch(() => ({}));
  const sizes = Object.keys(IMAGE_VIDEO_SIZES);
  const given = img.festival && img.festival.imageUrl;
  const job = {
    sizes,
    prompts: given ? {} : Object.fromEntries(sizes.map((s) => [s, sizedPrompt(img.prompt || '', s)])),
    ...(given ? { imageUrls: Object.fromEntries(sizes.map((s) => [s, img.festival.imageUrl])), subMargins: photoSubMargins(img.festival) } : {}),
    text: script.captionFull || script.captionShort || '',
    voiceId: cfg.voice_id || '',
    name: `${poster.slug(f.name)}-${poster.slug((img.sheet || {}).key || (given ? 'festival' : ''))}-r${inst.round || 1}`,
  };
  await imageVideoJob.start({ instance: inst, providers, job, baseUrl: settings.app.publicBaseUrl });
}

/** GitHub made everything: record it and open the approval. */
export async function githubDone(instanceId, result) {
  const log = baseLog.child({ instance: instanceId });
  const inst = await instanceRepo.get(instanceId);
  let steps = inst ? instanceService.parseSteps(inst) : [];
  const img = art(steps, 'images');
  if (!inst || inst.status !== 'running' || img.runner !== 'github') return log.info({ status: inst && inst.status }, 'GitHub video arrived late; ignored');
  const feedId = (result.imageIds || {}).feed;
  steps = patchStep(steps, 'images', {
    artifacts: {
      ...img,
      image: { url: result.images.feed, thumbnailUrl: feedId ? `https://drive.google.com/thumbnail?id=${feedId}&sz=w1000` : result.images.feed, driveId: feedId || null },
      images: result.images,
      render: { runner: 'github', videos: result.videos, videoIds: result.videoIds || {}, seconds: result.seconds, subtitled: result.subtitled, ...(result.subtitleError ? { subtitleError: result.subtitleError } : {}), ...(result.musicCredit ? { musicCredit: result.musicCredit } : {}) },
    },
  });
  const at = new Date().toISOString();
  if (result.made) steps = addCostToSteps(steps, 'images', { ...costImages({ count: result.made, size: '1024x1536' }), at });
  if (result.chars) steps = addCostToSteps(steps, 'images', { ...costTts({ provider: 'elevenlabs', chars: result.chars }), at });
  await instanceRepo.saveSteps(instanceId, steps, sumInstanceCost(steps));
  const ctx = await contextOf(inst, log);
  if (ctx) await finishReview(instanceId, ctx.f, log);
}

/** GitHub failed or went quiet: the fail-safe, else the instance fails. */
export async function githubFailed(instanceId, error) {
  const log = baseLog.child({ instance: instanceId });
  const inst = await instanceRepo.get(instanceId);
  if (!inst || inst.status !== 'running' || art(instanceService.parseSteps(inst), 'images').runner !== 'github') return null;
  const ctx = await contextOf(inst, log);
  if (!ctx) return instanceRepo.setStatus(instanceId, 'failed', 'funnel not found');
  try {
    await fallBack(instanceId, 'github', error, ctx.providers, log);
  } catch (err) {
    log.warn({ err: err.message }, 'image post not made');
  }
  return null;
}

/** Draw the three pictures on Railway (OpenAI, else Gemini) and upload them to Drive. */
async function drawOnRailway({ instanceId, f, providers, log }, img, round) {
  const given = img.festival && img.festival.imageUrl;
  if (given) {
    // Your own picture: every size uses it whole (the video fits it on a blurred copy of itself).
    const id = img.festival.driveId || null;
    const upload = { id, downloadUrl: given, thumbnailUrl: id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : given };
    return { upload, sized: Object.fromEntries(Object.keys(IMAGE_VIDEO_SIZES).map((s) => [s, given])), made: 0 };
  }
  const sized = {};
  let made = 0;
  const name = (size) => `${poster.slug(f.name)}-${poster.slug((img.sheet || {}).key || '')}-r${round || 1}${size === 'feed' ? '' : `-${size}`}.png`;
  const draw = async (size) => {
    const spec = IMAGE_VIDEO_SIZES[size];
    // Gemini draws square only: cropping that to 9:16 could cut the headline, so it stays whole
    // (the video fits it on a blurred copy of itself).
    const key = providers.resolved?.openai?.apiKey ? spec.gen : 'square';
    const image = await poster.generate(providers, sizedPrompt(img.prompt || '', size), imageSpec(spec.gen).size, key);
    made += 1;
    const up = await providers.storage.uploadPng(f.driveFolder, name(size), image);
    if (!up || !up.downloadUrl) throw new Error('the image could not be uploaded to Drive (is a Drive folder set on the funnel?)');
    return up;
  };
  // The 4:5 one is the preview and the picture-mode post; a size that fails uses it.
  const upload = await draw('feed');
  sized.feed = upload.downloadUrl;
  for (const size of ['portrait', 'landscape']) {
    try {
      sized[size] = (await draw(size)).downloadUrl;
    } catch (err) {
      log.warn({ err: err.message, size, instance: instanceId }, 'one image size failed, the 4:5 picture stands in');
    }
  }
  return { upload, sized, made };
}

/** The whole job on Railway: pictures, and in video mode the voice and the videos; then the approval. */
async function makeOnRailway(ctx) {
  const { instanceId, f, providers, video, log } = ctx;
  const inst = await instanceRepo.get(instanceId);
  let steps = instanceService.parseSteps(inst);
  const img = art(steps, 'images');
  const script = art(steps, 'script');
  const { upload, sized, made } = await drawOnRailway(ctx, img, inst.round);
  const at = new Date().toISOString();
  let render = null;
  let chars = 0;
  if (video) {
    const voiceCfg = await voiceSetup({ funnelId: f.id, providers, log });
    if (voiceCfg.error) throw new Error(voiceCfg.error);
    const voice = await imageShort.makeVoice({ tts: voiceCfg.tts, text: script.captionFull || script.captionShort || '', log });
    chars = voice.chars;
    const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
    const images = Object.fromEntries(Object.keys(IMAGE_VIDEO_SIZES).map((s) => [s, sized[s] || sized.feed]));
    const made2 = await imageShort.renderVideos({
      images, sizes: Object.keys(IMAGE_VIDEO_SIZES), voice, music: providers.resolved.shortMusic, upload: (path) => publish.uploadFile(path, 'video/mp4'), subMargins: photoSubMargins(img.festival), log,
    });
    render = { runner: 'railway', videos: made2.videos, seconds: made2.seconds, subtitled: made2.subtitled, ...(made2.subtitleError ? { subtitleError: made2.subtitleError } : {}), ...(made2.musicCredit ? { musicCredit: made2.musicCredit } : {}) };
  }
  steps = instanceService.parseSteps(await instanceRepo.get(instanceId));
  steps = patchStep(steps, 'images', {
    artifacts: {
      ...art(steps, 'images'),
      image: { url: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl, driveId: upload.id || null },
      images: sized,
      video,
      ...(render ? { render } : {}),
    },
  });
  // Real cost when OpenAI made it (Gemini has no per-image price table here).
  if (providers.resolved?.openai?.apiKey && made) steps = addCostToSteps(steps, 'images', { ...costImages({ count: made, size: '1024x1536' }), at });
  if (chars) steps = addCostToSteps(steps, 'images', { ...costTts({ provider: 'elevenlabs', chars }), at });
  await instanceRepo.saveSteps(instanceId, steps, sumInstanceCost(steps));
  await finishReview(instanceId, f, log);
}

/** Everything is made: open the approval (the daily email carries the link; the Library's Approve works too). */
async function finishReview(instanceId, f, log) {
  let steps = instanceService.parseSteps(await instanceRepo.get(instanceId));
  const img = art(steps, 'images');
  const script = art(steps, 'script');
  const image = img.image || {};
  // A GitHub video is in Drive: its player page plays it instead of downloading it.
  const vid = ((img.render || {}).videoIds || {}).portrait;
  const videoUrl = vid ? `https://drive.google.com/file/d/${vid}/view` : (((img.render || {}).videos || {}).portrait || '');
  const { id: approvalId } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: {
      instanceId, funnelId: f.id, mediaUrl: image.url, thumbnailUrl: image.thumbnailUrl,
      ...(videoUrl ? { videoUrl } : {}), captionFull: script.captionFull || '', captionShort: script.captionShort || '',
    },
  });
  steps = patchStep(steps, 'images', { status: 'done', finishedAt: new Date().toISOString(), artifacts: { ...img, approvalId } });
  await instanceRepo.saveSteps(instanceId, steps, sumInstanceCost(steps));
  await instanceRepo.setStatus(instanceId, IMAGE_REVIEW);
  await stepLog.end(instanceId, 'images');
  await stepLog.start(instanceId, 'review_image', { email: 'digest' });
  log.info({ instance: instanceId, row: (img.sheet || {}).key, video: !!videoUrl, runner: (img.render || {}).runner }, 'image post waiting for approval');
  // A festival post set to go out without a check is approved the moment its video is made.
  if (img.festival && img.festival.autoPost) {
    const r = await approvalService.approveById(approvalId).catch((err) => ({ ok: false, error: err.message }));
    log.info({ instance: instanceId, ok: r.ok }, 'festival post approved automatically');
  }
}


/** ↻ Retry a failed image post on the same instance: its sheet row again, back to approval. */
export async function retry({ instanceId, log = baseLog }) {
  const row = await instanceRepo.get(instanceId);
  const funnelRow = row && row.funnel_id ? await funnels.get(row.funnel_id) : null;
  if (!funnelRow) throw new LaneError('funnel not found');
  const f = await funnels.resolve(funnelRow);
  const providers = await buildProviders(f.tenantId);
  const festival = art(instanceService.parseSteps(row), 'images').festival;
  if (festival) return renderAndSend({ instanceId: row.id, f, providers, fields: { headline: row.title || '' }, sheet: {}, festival, log });
  const tab = await poster.tabFor(providers.sheets, f);
  const rows = await providers.sheets.readTab(f.sheetId, tab, { fresh: true });
  const pick = readyRows(rows).find((r) => r.key === row.source_ref);
  if (!pick) throw new LaneError('its row in the content sheet is no longer Ready');
  const sheet = { tab, matchColName: pick.fields.matchColName, key: pick.key, rowNumber: pick.rowNumber };
  await renderAndSend({ instanceId: row.id, f, providers, fields: pick.fields, sheet, log });
}

/**
 * Line up the image post for one funnel at `scheduledFor` (Luxon DateTime).
 * Returns the created instance row; throws LaneError / Error with the reason.
 */
export async function prepare({ funnelRow, scheduledFor, log = baseLog }) {
  const f = await funnels.resolve(funnelRow);
  if (!f.sheetId) throw new LaneError('no content sheet on this funnel');
  if (!(f.accounts || []).length) throw new LaneError('no Post for Me accounts ticked on this funnel');
  const providers = await buildProviders(f.tenantId);
  // Every image-post video carries the caption in the funnel's voice: no voice, no post (checked before any image is paid for).
  if (imageVideoMode(providers.resolved.imageVideo) === 'on') {
    const voice = await voiceSetup({ funnelId: f.id, providers, log });
    if (voice.error) throw new LaneError(voice.error);
  }
  const tab = await poster.tabFor(providers.sheets, f);
  let rows = await providers.sheets.readTab(f.sheetId, tab, { fresh: true });
  if (!rows.length) throw new LaneError('the content sheet is empty (no header row)');
  if (!extractRow(rows[0], []).hasSchema) throw new LaneError('the content sheet needs a Status and an image prompt column');

  const open = await instanceRepo.openSheetRefs(f.id, f.tenantId);
  const free = readyRows(rows).filter((r) => !open.includes(r.key));
  let refillSpan = null;
  if (free.length < REFILL_BELOW) {
    const from = new Date().toISOString();
    rows = await refill({ f, providers, tab, rows, log }).catch((err) => {
      log.warn({ err: err.message }, 'image sheet refill failed (using what is there)');
      return rows;
    });
    refillSpan = [from, new Date().toISOString()];
  }
  const pick = pickReadyRow(rows, open);
  if (!pick) throw new LaneError('no Ready row in the content sheet, and the refill wrote none');

  const inst = await instanceService.createForFunnel({
    tenantId: f.tenantId,
    funnel: funnelRow,
    title: `${pick.fields.headline || 'Image post'} · ${formatIst(scheduledFor, { withTime: false })}`,
    scheduledFor: scheduledFor.toJSDate(),
    status: 'running',
    sourceType: 'sheet',
    sourceRef: pick.key,
  });
  if (refillSpan) await stepLog.span(inst.id, 'refill', refillSpan[0], refillSpan[1]);
  const sheet = { tab, matchColName: pick.fields.matchColName, key: pick.key, rowNumber: pick.rowNumber };
  try {
    await renderAndSend({ instanceId: inst.id, f, providers, fields: pick.fields, sheet, log });
  } catch (err) {
    await instanceRepo.setStatus(inst.id, 'failed', `Image lane: ${err.message}`).catch(() => {});
    throw err;
  }
  return inst;
}

/**
 * A festival post for one funnel: your uploaded picture and your copy, made into
 * the same voiced videos as an image post (the copy is read aloud in the funnel's
 * voice), outside the router. festival: { batchId, imageUrl, driveId, copy, autoPost }.
 * postAt: a Date, or null to post as soon as it is approved. Returns the instance.
 */
export async function prepareFestival({ funnelRow, title, festival, postAt = null, log = baseLog }) {
  const f = await funnels.resolve(funnelRow);
  if (!(f.accounts || []).length) throw new LaneError('no Post for Me accounts ticked on this funnel');
  const providers = await buildProviders(f.tenantId);
  const voice = await voiceSetup({ funnelId: f.id, providers, log });
  if (voice.error) throw new LaneError(voice.error);
  const inst = await instanceService.createForFunnel({
    tenantId: f.tenantId,
    funnel: funnelRow,
    title: title || 'Festival post',
    scheduledFor: postAt || new Date(),
    status: 'running',
    sourceType: 'festival',
    sourceRef: festival.batchId,
  });
  try {
    await renderAndSend({ instanceId: inst.id, f, providers, fields: { headline: title || '' }, sheet: {}, festival, log });
  } catch (err) {
    await instanceRepo.setStatus(inst.id, 'failed', `Festival post: ${err.message}`).catch(() => {});
    throw err;
  }
  return inst;
}

/** Why a funnel can't take a festival post ('' when it can): accounts and the voice, checked before anything is made. */
export async function festivalProblem(funnelRow, providers, log = baseLog) {
  const f = await funnels.resolve(funnelRow);
  if (!(f.accounts || []).length) return 'no Post for Me accounts ticked on this funnel';
  const voice = await voiceSetup({ funnelId: f.id, providers, log });
  return voice.error || '';
}

/** A still's bytes: from Drive, else its public link (stills are shared when uploaded). */
async function stillBuffer(providers, still) {
  if (still.driveId) {
    try {
      return await providers.storage.download(still.driveId);
    } catch (err) {
      if (!still.url) throw err;
    }
  }
  const res = await fetch(still.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`the still could not be downloaded (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Open the image approval for what the instance holds. Leaves it at image_review. */
async function openApproval({ row, funnelId, image, captionFull, captionShort }) {
  const { id: approvalId } = await approvalService.createRequest({
    tenantId: row.tenant_id,
    kind: KIND,
    payload: { instanceId: row.id, funnelId, mediaUrl: image.url, thumbnailUrl: image.thumbnailUrl, captionFull, captionShort },
  });
  return approvalId;
}

/**
 * A router AI video's animation failed: the same instance becomes an image post,
 * from the still already made for animating, with the headline and sub-head drawn
 * on it. No new image is paid for unless a reviewer sends it back with a note, and
 * no sheet is needed. Then the usual image approval. Returns false when the instance
 * has moved on; throws when the still can't be used (the caller tries the sheet).
 */
export async function stepDown({ instanceId, reason = '', note = '', log = baseLog }) {
  const row = await instanceRepo.get(instanceId);
  const funnelRow = row && row.funnel_id ? await funnels.get(row.funnel_id) : null;
  if (!funnelRow) throw new LaneError('funnel not found');
  const f = await funnels.resolve(funnelRow);
  if (!(f.accounts || []).length) throw new LaneError('no Post for Me accounts ticked on this funnel');
  const steps = instanceService.parseSteps(row);
  const still = stepDownPicture(steps);
  if (!still) throw new LaneError('no generated still to reuse');
  const brief = art(steps, 'script').brief || {};
  const { headline, subhead } = stepDownText(brief, row.title);
  if (!headline) throw new LaneError('no headline to draw');
  // Atomic: from failed, or from running when a rework or a retry already claimed it.
  if (!(await instanceRepo.transition(row.id, row.status, 'running'))) return false;

  try {
    const providers = await buildProviders(f.tenantId);
    const cfg = await funnels.getConfig(f.id).catch(() => ({}));
    await stepLog.start(row.id, 'draw_image');
    let upload;
    try {
      const base = note
        ? await poster.generate(providers, stepDownPrompt(still.prompt, note), f.imageSize, f.imageKey)
        : await stillBuffer(providers, still);
      const png = await headlineImage(base, { text: headline, sub: subhead });
      upload = await providers.storage.uploadPng(cfg.drive_folder_id || f.driveFolder || '', `${poster.slug(f.name)}-stepdown-${String(row.id).slice(0, 8)}-r${row.round || 1}.png`, png);
      if (!upload || !upload.downloadUrl) throw new Error('the image could not be uploaded to Drive (is a Drive folder set on the funnel?)');
    } catch (err) {
      await stepLog.fail(row.id, 'draw_image');
      throw err;
    }
    await stepLog.end(row.id, 'draw_image');

    const image = { url: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl, driveId: upload.id || null };
    const caption = stepDownCaption({ brief, ctaLink: f.ctaLink, audiencePrefix: f.audiencePrefix, title: row.title });
    const approvalId = await openApproval({ row, funnelId: f.id, image, captionFull: caption, captionShort: caption });

    const first = !stepDownOf(steps);
    const why = stepDownOf(steps)?.reason || reason;
    const info = { from: 'animate', reason: why, note: stepDownNote(why), stillDriveId: still.driveId || null, headline, subhead, at: new Date().toISOString() };
    let next = steps;
    for (const k of ['voiceover', 'transcript', 'stitch']) next = patchStep(next, k, { status: 'skipped' });
    next = patchStep(next, 'script', { artifacts: { copy: { title: headline, description: caption }, captionFull: caption, captionShort: caption } });
    next = patchStep(next, 'images', { artifacts: { image, prompt: still.prompt || '', note: note || '', row: {}, sheet: {}, approvalId, stepDown: info } });
    // The clips made before the failure were paid for, and nothing else will record them.
    const anim = art(steps, 'animate');
    if (first && (anim.clips || []).length && !((steps.find((s) => s.key === 'animate') || {}).costs || []).length) {
      next = addCostToSteps(next, 'animate', { ...costAnimation({ provider: anim.provider, seconds: totalClipSeconds(cfg.clip_length, anim.clips.length, anim.provider) }), at: new Date().toISOString() });
    }
    if (note && providers.resolved?.openai?.apiKey) {
      next = addCostToSteps(next, 'images', { ...costImages({ count: 1, size: f.imageSize }), at: new Date().toISOString() });
    }
    await instanceRepo.saveSteps(row.id, next, sumInstanceCost(next));
    if (first) await stepLog.mark(row.id, 'step_down', info.note);
    await instanceRepo.setStatus(row.id, IMAGE_REVIEW, info.note);
    await stepLog.start(row.id, 'review_image', { email: 'digest' });
    log.info({ instance: row.id, still: still.driveId, reason: why }, 'animation failed; image post from the still waiting for approval');
    return true;
  } catch (err) {
    await instanceRepo.setStatus(row.id, 'failed', `Image step-down: ${err.message}`).catch(() => {});
    throw err;
  }
}

/** ↻ Retry a stepped-down post that failed: the image it has, back to approval. */
export async function retryStepDown({ instanceId, log = baseLog }) {
  const row = await instanceRepo.get(instanceId);
  if (!row) throw new LaneError('instance not found');
  const steps = instanceService.parseSteps(row);
  const img = art(steps, 'images');
  if (!(img.image && img.image.url)) return stepDown({ instanceId, reason: stepDownOf(steps)?.reason || '', log });
  const script = art(steps, 'script');
  const approvalId = await openApproval({ row, funnelId: row.funnel_id, image: img.image, captionFull: script.captionFull || '', captionShort: script.captionShort || '' });
  const next = patchStep(steps, 'images', { artifacts: { approvalId } });
  await instanceRepo.saveSteps(row.id, next, sumInstanceCost(next));
  await instanceRepo.setStatus(row.id, IMAGE_REVIEW);
  await stepLog.start(row.id, 'review_image', { email: 'digest' });
  return true;
}

/** The sheet row an image instance came from (for status writes). A stepped-down video has none. */
async function sheetFor(row) {
  const funnel = row.funnel_id ? await funnels.get(row.funnel_id) : null;
  if (!funnel) return null;
  const f = await funnels.resolve(funnel);
  const providers = await buildProviders(f.tenantId);
  const steps = instanceService.parseSteps(row);
  const sheet = art(steps, 'images').sheet || {};
  const ownRow = !stepDownOf(steps) && !art(steps, 'images').festival;
  const tab = sheet.tab || (ownRow ? await poster.tabFor(providers.sheets, f) : '');
  return { f, providers, steps, sheet, tab };
}

/** Approve → sheet Approved → Post for Me (scheduled, or now if late) → instance scheduled. */
export async function approve(approval) {
  const p = approval.payload || {};
  const row = p.instanceId ? await instanceRepo.get(p.instanceId) : null;
  const log = baseLog.child({ instance: p.instanceId });
  if (!row) return log.warn('approved image post has no instance; ignored');
  // Atomic: a second click (or an older email's link) acts only once.
  if (!(await instanceRepo.transition(row.id, IMAGE_REVIEW, 'approved'))) {
    return log.info({ status: row.status }, 'image post is not awaiting approval; ignored');
  }
  await stepLog.end(row.id, 'review_image', { by: 'approved' });
  await stepLog.start(row.id, 'publish');
  const ctx = await sheetFor(row);
  if (!ctx) return instanceRepo.setStatus(row.id, 'failed', 'funnel not found');
  const { f, providers, sheet, tab } = ctx;
  let { steps } = ctx;
  const where = { matchColName: sheet.matchColName, matchKey: sheet.key, rowNumber: sheet.rowNumber };
  // A post stepped down from a video has no row of its own (the posted log appends one when it is live).
  const markRow = (fields) => (sheet.key ? poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, ...fields }, log) : null);
  await markRow({ status: SHEET_STATUS.approved });

  const script = art(steps, 'script');
  const img = art(steps, 'images');
  const full = script.captionFull || '';
  const short = script.captionShort || '';
  const accountMap = f.accountMap || {};
  const accounts = imageAccounts(f.accounts, accountMap);
  const postAt = postAtFor(row.scheduled_for); // D2: null = it's late, post now
  const configs = buildPlatformConfigs(full, short);
  const req = { caption: short || full, mediaUrl: (img.image || {}).url || p.mediaUrl, ...(configs ? { platformConfigurations: configs } : {}) };
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
  const ytConfig = { title: shortTitle(row.title, short || full), caption: full || short };
  // Default: every channel gets a video of the picture with music and the
  // caption read in the funnel's voice. No voice = nothing is posted.
  // Each platform gets its own size: 9:16 Reels and Shorts, 4:5 LinkedIn and Threads, 16:9 X.
  const platforms = (f.accounts || []).map((id) => platformKey((accountMap[id] || {}).platform));
  // Older posts (and a stepped-down video) have one picture: the video fits it to each size.
  const pictures = { ...(img.images || {}) };
  const sizes = sizesNeeded(platforms);
  const images = Object.fromEntries(sizes.map((s) => [s, pictures[s] || req.mediaUrl]));
  // The videos were made before the approval (what you approved is what goes
  // out); a post prepared before that is made now. The whole caption is read
  // aloud and the video is as long as the reading.
  const ready = img.render && img.render.videos && img.render.videos.portrait ? img.render : null;
  const video = ready
    ? { videos: ready.videos, url: ready.videos.portrait, seconds: ready.seconds, voiced: true, subtitled: ready.subtitled, subtitleError: ready.subtitleError || '', chars: 0, runner: ready.runner, musicCredit: ready.musicCredit || '' }
    : await videoFor({ row, f, providers, publish, images, sizes, text: full || short, log });
  if (video && video.error) {
    log.error({ err: video.error }, 'voice video not made; nothing posted');
    await stepLog.fail(row.id, 'publish');
    steps = patchStep(steps, 'publish', { status: 'failed', error: video.error });
    await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
    await instanceRepo.setStatus(row.id, 'failed', `Voice video not made, nothing posted: ${video.error}`);
    await markRow({ status: SHEET_STATUS.ready });
    return null;
  }
  if (video) {
    // Your credit for the music that was used goes last in every caption (X only when it still fits 280).
    req.platformConfigurations = imageVideoConfigs({
      platforms, full: withMusicCredit(full, video.musicCredit), short: withMusicCredit(short, video.musicCredit, 280), title: ytConfig.title, videos: video.videos, images,
    });
    req.imageUrl = req.mediaUrl;
    req.mediaUrl = video.url;
    req.imageVideo = {
      seconds: video.seconds, voiced: video.voiced, subtitled: video.subtitled, sizes: Object.keys(video.videos),
      ...(video.voiceError ? { voiceError: video.voiceError } : {}),
      ...(video.subtitleError ? { subtitleError: video.subtitleError } : {}),
    };
    accounts.splice(0, accounts.length, ...(f.accounts || []));
    if (video.chars) steps = addCostToSteps(steps, 'publish', { ...costTts({ provider: 'elevenlabs', chars: video.chars }), at: new Date().toISOString() });
  }
  // YouTube takes no images: it gets the picture as a Short, on a post of its own.
  const ytAccounts = (f.accounts || []).filter((id) => !accounts.includes(id));
  let shortUrl = '';
  let shortRef = null;
  let shortError = '';
  if (ytAccounts.length) {
    try {
      shortUrl = await imageShort.make({ imageUrl: req.mediaUrl, publish, music: providers.resolved.shortMusic, log });
      const made = await publish.createPost({ accountIds: ytAccounts, scheduledAt: postAt || undefined, caption: ytConfig.caption, mediaUrl: shortUrl, platformConfigurations: { youtube: ytConfig } });
      shortRef = made && made.id ? made.id : null;
      if (!shortRef) throw new Error('Post for Me did not return a post id');
    } catch (err) {
      shortError = String(err.message).slice(0, 200);
      log.warn({ err: err.message }, 'YouTube Short failed (the image post goes on; Retry tries it again)');
    }
  }
  let ref = null;
  try {
    if (accounts.length) {
      const result = await publish.createPost({ accountIds: accounts, scheduledAt: postAt || undefined, ...req });
      ref = result && result.id ? result.id : null;
      if (!ref) throw new Error('Post for Me did not return a post id');
    } else if (!shortRef) {
      throw new Error(shortError || 'no Post for Me accounts ticked on this funnel');
    }
  } catch (err) {
    if (shortRef) await publish.deletePost(shortRef).catch((e) => log.warn({ err: e.message, shortRef }, 'could not withdraw the Short'));
    log.error({ err: err.message }, 'image post could not be created');
    await stepLog.fail(row.id, 'publish');
    steps = patchStep(steps, 'publish', { status: 'failed', error: err.message });
    await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
    await instanceRepo.setStatus(row.id, 'failed', `Post for Me: ${err.message}`);
    await markRow({ status: SHEET_STATUS.ready });
    return null;
  }

  // The link goes in each channel's first comment once the post is live; the
  // webhook is what wakes a sleeping app when it goes live.
  const refs = [ref, shortRef].filter(Boolean);
  // A festival greeting carries no sales link in its first comment.
  const festive = !!img.festival;
  if (!festive) for (const made of refs) await firstComment.queue({ tenantId: f.tenantId, postformePostId: made, link: f.ctaLink, scheduledAt: postAt });
  await firstComment.ensureWebhook(f.tenantId, publish).catch(() => false);
  const fields = img.row || {};
  if (ref && !festive) await poster.armPostExtras({ f, p: { dmKeyword: fields.dmKeyword, dmText: fields.dmText, dmLink: fields.dmLink, matchKey: sheet.key }, ref, accounts, log });

  const channel = (id) => ({ id, platform: (accountMap[id] || {}).platform || '', name: (accountMap[id] || {}).account_name || id, state: 'waiting' });
  const channels = [
    ...accounts.map(channel),
    ...ytAccounts.map((id) => ({ ...channel(id), as: 'Short from image', ...(shortRef ? {} : { state: 'failed', error: `Short not made: ${shortError}` }) })),
  ];
  const saved = { ...req, ...(shortRef ? { shortUrl } : {}), ...(ytAccounts.length ? { shortConfig: ytConfig } : {}) };
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: refs, caption: req.caption, channels, request: saved } });
  await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
  await stepLog.end(row.id, 'publish');
  await instanceRepo.markScheduled(row.id, { postRefs: refs, scheduledFor: postAt ? new Date(postAt) : null, postNow: !postAt });
  await markRow({ extra: { [PFM_COL]: refs.join(', ') } });
  await setApprovalStatus(approval.id, 'published');
  log.info({ refs, postAt: postAt || 'now', accounts: accounts.length, shorts: shortRef ? ytAccounts.length : 0 }, 'image post handed to Post for Me');
  return refs[0];
}

/**
 * The funnel's voice for image-post videos: { tts } or { error } saying what
 * to set up. Both the voice (lane setup) and the ElevenLabs key are needed.
 */
async function voiceSetup({ funnelId, providers, log }) {
  const cfg = await funnels.getConfig(funnelId).catch(() => ({}));
  const apiKey = ((providers.resolved.tts || {}).elevenlabsApiKey) || '';
  if (!cfg.voice_id) return { error: 'no voice chosen for this funnel: pick one in its lane setup (Lane 2, Voice)' };
  if (!apiKey) return { error: 'no ElevenLabs key: add it on Keys and credit' };
  if (String(cfg.tts_provider || 'elevenlabs').toLowerCase() !== 'elevenlabs') return { error: 'image-post videos need an ElevenLabs voice (this funnel uses another voice provider)' };
  return { tts: createTtsProvider({ provider: 'elevenlabs', apiKey, voiceId: cfg.voice_id }, log) };
}

/**
 * The image post as voiced videos, per Settings (image_video): null when it is
 * set to the picture or the funnel posts nowhere; { error } when the voice or
 * the render failed (nothing is posted then: every video carries the voice).
 */
async function videoFor({ row, f, providers, publish, images, sizes, text, log }) {
  const mode = imageVideoMode(providers.resolved.imageVideo);
  if (mode === 'off' || !(f.accounts || []).length) return null;
  if (!Object.values(images || {}).some(Boolean)) return { error: 'no picture to make the video from' };
  const voice = await voiceSetup({ funnelId: row.funnel_id, providers, log });
  if (voice.error) return { error: voice.error };
  try {
    const made = await imageShort.makeVideo({ images, sizes, publish, music: providers.resolved.shortMusic, text, tts: voice.tts, requireVoice: true, log });
    log.info({ seconds: made.seconds, subtitled: made.subtitled, sizes: Object.keys(made.videos) }, 'image post rendered as voiced videos');
    return made;
  } catch (err) {
    return { error: String(err.message).slice(0, 300) };
  }
}

/** Rework (reject with a note): regenerate the image and re-send the approval. */
export async function rework(approval, note) {
  const p = approval.payload || {};
  const row = p.instanceId ? await instanceRepo.get(p.instanceId) : null;
  const log = baseLog.child({ instance: p.instanceId });
  if (!row) return log.warn('reworked image post has no instance; ignored');
  if (!(await instanceRepo.transition(row.id, IMAGE_REVIEW, 'running', note || null))) {
    return log.info({ status: row.status }, 'image post is not awaiting approval; rework ignored');
  }
  await stepLog.end(row.id, 'review_image', { by: 'rework' });
  await instanceRepo.bumpRound(row.id);
  const ctx = await sheetFor(row);
  if (!ctx) return instanceRepo.setStatus(row.id, 'failed', 'funnel not found');
  const img = art(ctx.steps, 'images');
  try {
    if (img.stepDown) {
      await stepDown({ instanceId: row.id, note: note || '', log });
      return null;
    }
    if (img.festival) {
      // Your picture stays; Send back makes the voice and the videos again.
      await renderAndSend({ instanceId: row.id, f: ctx.f, providers: ctx.providers, fields: img.row || {}, sheet: {}, festival: { ...img.festival, autoPost: false }, log });
      return null;
    }
    await renderAndSend({ instanceId: row.id, f: ctx.f, providers: ctx.providers, fields: img.row || {}, sheet: { ...ctx.sheet, tab: ctx.tab }, note: note || '', log });
  } catch (err) {
    log.error({ err: err.message }, 'image rework failed');
    await instanceRepo.setStatus(row.id, 'failed', `Rework: ${err.message}`);
  }
  return null;
}

/**
 * Post check hook: an image instance is live → its sheet row is Posted, the
 * post id, and the live links of the channels that made it, one per line so
 * they can be copied straight out of the cell. A channel whose platform
 * returned no permalink contributes no line.
 */
export async function onPosted(row, { refs = [], channels = [] } = {}) {
  if (!row || row.source_type !== 'sheet') return;
  const ctx = await sheetFor(row);
  if (!ctx) return;
  const ids = (refs.length ? refs : (Array.isArray(row.post_refs) ? row.post_refs : [])).filter(Boolean);
  const links = postedLinks(channels);
  await poster.markSheetRow(ctx.providers.sheets, ctx.f.sheetId, ctx.tab, {
    matchColName: ctx.sheet.matchColName, matchKey: ctx.sheet.key, rowNumber: ctx.sheet.rowNumber,
    status: SHEET_STATUS.posted,
    extra: { [PFM_COL]: ids.join(', '), ...(links.length ? { [LINKS_COL]: links.join(CELL_NEWLINE) } : {}) },
  }, baseLog);
}

export default { KIND, LaneError, landingText, prepare, prepareFestival, festivalProblem, retry, stepDown, retryStepDown, approve, rework, onPosted };
