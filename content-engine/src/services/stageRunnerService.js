/**
 * Stage runner (the pipeline's engine).
 *
 * Purpose:      Drive one instance through its artifact-producing stages — script,
 *               images, image->video, voiceover, transcript, FFmpeg stitch,
 *               publish — calling the right provider at each step, uploading the
 *               artifact to the funnel's Drive folder, and recording the REAL
 *               per-step AI cost (measured usage × the price table). Connects the
 *               slice 3/4 seams: scheduler -> script -> script review; approve ->
 *               run stages -> final review; approve final -> post + lock; reject
 *               -> regenerate from the correction.
 * Responsibility: Orchestration + per-step side effects. Pure logic (prompts,
 *               scene split, ffmpeg argv, SRT, sizing) lives in utils/stageSpec.
 * Dependencies: providerFactory, provider factories (tts/transcript/ffmpeg/
 *               animation/publish), funnelsRepository, instanceService,
 *               instanceRepository, instanceReviewService (requestReview +
 *               setPipelineHooks), utils/{stageSpec,imageGateSpec,animationSpec,
 *               pricing}, logger.
 *
 * On any step error the step + instance are marked failed and the run stops; a
 * missing provider key therefore fails the instance cleanly rather than crashing.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceService from '../services/instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as review from './instanceReviewService.js';
import { buildProviders } from './providerFactory.js';
import { createTtsProvider } from '../providers/ttsProvider.js';
import { createTranscriptProvider } from '../providers/transcriptProvider.js';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import { createAnimationProvider } from '../providers/animationProvider.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import * as captureRules from './captureRules.js';
import { dlUrl } from '../providers/storageProvider.js';
import { costText, costImages, costAnimation, costTts, costTranscript } from '../utils/pricing.js';
import { mapImageSize } from '../utils/imageGateSpec.js';
import { resolveAnimationConfig } from '../utils/animationSpec.js';
import {
  scriptSystemPrompt,
  scriptUserPrompt,
  clampSceneCount,
  splitScriptToScenes,
  sceneImagePrompt,
  aspectToSize,
  totalClipSeconds,
  buildMediaName,
  buildSrt,
} from '../utils/stageSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'stageRunner' });

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${String(url).slice(0, 80)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Load the instance + its funnel (row, raw config, resolved) + providers. */
async function loadContext(instanceId) {
  const instance = await instanceService.get(instanceId);
  if (!instance) throw new Error(`instance ${instanceId} not found`);
  const funnel = instance.funnel_id ? await funnels.get(instance.funnel_id) : null;
  const cfg = funnel ? await funnels.getConfig(funnel.id).catch(() => ({})) : {};
  const resolved = funnel ? await funnels.resolve(funnel).catch(() => ({})) : {};
  const providers = await buildProviders(instance.tenant_id || 'default');
  return { instance, funnel, cfg, resolved, providers };
}

function scriptTextOf(instance) {
  const steps = instanceService.parseSteps(instance);
  const s = steps.find((x) => x.key === 'script');
  return (s && s.artifacts && s.artifacts.text) || '';
}

async function markFailed(instanceId, stepKey, err) {
  log.error({ err: err.message, instance: instanceId, step: stepKey }, 'stage failed');
  try {
    if (stepKey) await instanceService.updateStep(instanceId, stepKey, { status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
    await instanceRepo.setStatus(instanceId, 'failed', `${stepKey || 'stage'}: ${err.message}`);
  } catch (e) {
    log.error({ err: e.message, instance: instanceId }, 'failed to mark instance failed');
  }
}

// ---- individual stages -----------------------------------------------------

/** Generate the script and record its real token cost. Returns the text. */
export async function generateScript({ instanceId, correction = '' }) {
  const { instance, funnel, cfg, resolved, providers } = await loadContext(instanceId);
  await instanceService.updateStep(instanceId, 'script', { status: 'running', startedAt: new Date().toISOString() });
  const { text, model, usage } = await providers.llm.generateTextDetailed({
    system: scriptSystemPrompt(cfg.script_tone),
    user: scriptUserPrompt({ topic: funnel?.name || instance.title || '', audience: resolved.audiencePrefix || '', correction }),
  });
  if (!text) throw new Error('empty script from model');
  await instanceService.updateStep(instanceId, 'script', { status: 'done', artifacts: { text }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instanceId, 'script', costText({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model }));
  return text;
}

/** Generate the stills for the script and record image cost. Returns images[]. */
async function runImages(ctx) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const size = mapImageSize(cfg.image_size);
  const count = clampSceneCount(cfg.image_count, 4);
  const scenes = splitScriptToScenes(scriptTextOf(instance), count);
  const stamp = Date.now().toString(36);

  await instanceService.updateStep(instance.id, 'images', { status: 'running', startedAt: new Date().toISOString() });
  const images = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const prompt = sceneImagePrompt(scenes[i], cfg.image_style);
    const buf = await providers.llm.generateImage({ prompt, size });
    const up = await providers.storage.uploadMedia(folder, buildMediaName('img', stamp, i, 'png'), 'image/png', buf);
    images.push({ driveId: up.id, url: up.downloadUrl, prompt });
  }
  await instanceService.updateStep(instance.id, 'images', { status: 'done', artifacts: { images }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'images', costImages({ count: images.length, size }));
  return images;
}

/** Animate each still into a clip, upload to Drive, record animation cost. */
async function runAnimate(ctx, images) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const animCfg = resolveAnimationConfig(cfg);
  const anim = createAnimationProvider(animCfg, log);
  const stamp = Date.now().toString(36);

  await instanceService.updateStep(instance.id, 'animate', { status: 'running', startedAt: new Date().toISOString() });
  const clips = [];
  for (let i = 0; i < images.length; i += 1) {
    const clipUrl = await anim.animateAndWait({ imageUrl: images[i].url, prompt: images[i].prompt });
    const buf = await fetchBuffer(clipUrl);
    const up = await providers.storage.uploadMedia(folder, buildMediaName('clip', stamp, i, 'mp4'), 'video/mp4', buf);
    clips.push({ driveId: up.id, url: up.downloadUrl, sourceImageId: images[i].driveId });
  }
  await instanceService.updateStep(instance.id, 'animate', { status: 'done', artifacts: { clips }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'animate', costAnimation({ provider: anim.provider, seconds: totalClipSeconds(cfg.clip_length, clips.length) }));
  return clips;
}

/** Clone the voice over the script, upload the audio, record TTS cost. */
async function runVoiceover(ctx) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const tts = createTtsProvider({ provider: cfg.tts_provider, apiKey: cfg.tts_api_key, voiceId: cfg.voice_id }, log);

  await instanceService.updateStep(instance.id, 'voiceover', { status: 'running', startedAt: new Date().toISOString() });
  const { buffer, chars } = await tts.synthesize({ text: scriptTextOf(instance) });
  const up = await providers.storage.uploadMedia(folder, buildMediaName('voice', Date.now().toString(36), 0, 'mp3'), 'audio/mpeg', buffer);
  await instanceService.updateStep(instance.id, 'voiceover', { status: 'done', artifacts: { audio: { driveId: up.id } }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'voiceover', costTts({ provider: tts.provider, chars }));
  return { audioBuffer: buffer, audioDriveId: up.id };
}

/** Transcribe the voiceover for timed captions, record transcription cost. */
async function runTranscript(ctx, audioBuffer, audioDriveId) {
  const { instance, cfg, providers } = ctx;
  const tp = createTranscriptProvider({ apiKey: cfg.transcript_api_key || providers.resolved.openai.apiKey }, log);

  await instanceService.updateStep(instance.id, 'transcript', { status: 'running', startedAt: new Date().toISOString() });
  const { text, minutes, durationSeconds, cues } = await tp.transcribe({ buffer: audioBuffer });
  // Persist cues too, so a manual stitch (run separately) can burn captions.
  await instanceService.updateStep(instance.id, 'transcript', { status: 'done', artifacts: { text, cues: cues || [] }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'transcript', costTranscript({ provider: tp.provider, minutes }));
  // Fill in the voiceover duration now that we know it (preserve the driveId).
  if (durationSeconds) {
    await instanceService.updateStep(instance.id, 'voiceover', { artifacts: { audio: { driveId: audioDriveId, durationSec: Math.round(durationSeconds) } } });
  }
  return { cues, durationSeconds };
}

/** Stitch clips + voiceover (+ captions) into the final reel (local ffmpeg). */
async function runStitch(ctx, clips, audioBuffer, cues) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const { width, height } = aspectToSize(cfg.aspect);
  const ffmpeg = createFfmpegProvider({}, log);

  await instanceService.updateStep(instance.id, 'stitch', { status: 'running', startedAt: new Date().toISOString() });
  const clipBuffers = [];
  for (const c of clips) clipBuffers.push(await providers.storage.download(c.driveId));
  const srtText = (String(cfg.burn_captions || 'on') !== 'off' && Array.isArray(cues) && cues.length) ? buildSrt(cues) : '';
  const { buffer, durationSeconds } = await ffmpeg.stitch({ clipBuffers, audioBuffer, width, height, srtText });
  const up = await providers.storage.uploadMedia(folder, buildMediaName('reel', Date.now().toString(36), 0, 'mp4'), 'video/mp4', buffer);
  await instanceService.updateStep(instance.id, 'stitch', { status: 'done', artifacts: { video: { driveId: up.id, durationSec: Math.round(durationSeconds) } }, finishedAt: new Date().toISOString() });
  await instanceRepo.setMeta(instance.id, { durationSeconds: Math.round(durationSeconds) });
  return { videoDriveId: up.id, durationSeconds };
}

// ---- orchestration (the seams) ---------------------------------------------

/** Scheduler seam: generate the script, then open the script-review checkpoint. */
export async function runScriptAndReview({ instanceId }) {
  try {
    await generateScript({ instanceId });
    await review.requestReview({ instanceId, checkpoint: 'script' });
  } catch (err) {
    await markFailed(instanceId, 'script', err);
  }
}

/** Approve-script seam: run every stage, then open the final-review checkpoint. */
export async function runStages({ instanceId }) {
  let ctx;
  let step = 'images';
  try {
    ctx = await loadContext(instanceId);
    const images = await runImages(ctx);
    step = 'animate';
    const clips = await runAnimate(ctx, images);
    step = 'voiceover';
    const { audioBuffer, audioDriveId } = await runVoiceover(ctx);
    step = 'transcript';
    const { cues } = await runTranscript(ctx, audioBuffer, audioDriveId);
    step = 'stitch';
    await runStitch(ctx, clips, audioBuffer, cues);
    await review.requestReview({ instanceId, checkpoint: 'final' });
  } catch (err) {
    await markFailed(instanceId, step, err);
  }
}

/** Final-approve seam: post the reel to Post-for-Me; return the post refs. */
export async function postInstance({ instanceId, captionOverride = '' }) {
  const { instance, cfg, resolved, providers } = await loadContext(instanceId);
  const steps = instanceService.parseSteps(instance);
  const stitch = steps.find((s) => s.key === 'stitch');
  const videoId = stitch && stitch.artifacts && stitch.artifacts.video ? stitch.artifacts.video.driveId : '';
  if (!videoId) throw new Error('no final reel to post');

  const accountIds = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  const postformeKey = resolved.postformeKey || cfg.postforme_api_key || '';
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);

  await providers.storage.shareAnyone(videoId);
  const caption = (captionOverride && captionOverride.trim())
    || [resolved.audiencePrefix, resolved.ctaLink].filter(Boolean).join('\n') || instance.title || '';
  const scheduledAt = instance.scheduled_for ? new Date(instance.scheduled_for).toISOString() : undefined;

  const result = await publish.createPost({ accountIds, caption, mediaUrl: dlUrl(videoId), scheduledAt });
  const refs = result && result.id ? [result.id] : (Array.isArray(result) ? result.map((r) => r.id).filter(Boolean) : []);
  await instanceService.updateStep(instanceId, 'publish', { status: 'done', artifacts: { posts: refs }, finishedAt: new Date().toISOString() });
  log.info({ instance: instanceId, accounts: accountIds.length, refs: refs.length }, 'instance posted to Post-for-Me');

  // Arm comment-to-DM for the pipeline path (funnel-level keyword/dm defaults).
  if (refs[0] && resolved.captureKeyword) {
    await captureRules.createForPublish({
      tenantId: resolved.tenantId, funnelId: resolved.id, lane: resolved.name,
      platforms: captureRules.dmPlatforms(accountIds, resolved.accountMap),
      postformePostId: refs[0],
      keyword: resolved.captureKeyword, dmText: resolved.captureDmText, dmLink: resolved.captureDmLink,
      publicReplyVariants: resolved.capturePublicReplies, log,
    }).catch((err) => log.warn({ err: err.message }, 'capture rule create failed (posted anyway)'));
  }
  return refs;
}

/** Rework seam: regenerate from the correction, then re-open the checkpoint. */
export async function regenerate({ instanceId, checkpoint, correction }) {
  try {
    if (checkpoint === 'script') {
      await generateScript({ instanceId, correction });
      await review.requestReview({ instanceId, checkpoint: 'script' });
    } else {
      // Final rejected: re-run the downstream stages from the existing script
      // (the correction is recorded on the instance note) then re-review.
      await runStages({ instanceId });
    }
  } catch (err) {
    await markFailed(instanceId, checkpoint === 'script' ? 'script' : 'images', err);
  }
}

// ---- manual stepper (run ONE stage at a time, from persisted artifacts) ----

function stepArtifacts(instance, key) {
  const s = instanceService.parseSteps(instance).find((x) => x.key === key);
  return (s && s.artifacts) || {};
}

/** Images with optional per-scene prompt overrides (else derived from script). */
async function manualImages(ctx, prompts) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const size = mapImageSize(cfg.image_size);
  const overrides = Array.isArray(prompts) ? prompts.map((p) => String(p || '').trim()).filter(Boolean) : [];
  const finalPrompts = overrides.length
    ? overrides
    : splitScriptToScenes(scriptTextOf(instance), clampSceneCount(cfg.image_count, 4)).map((sc) => sceneImagePrompt(sc, cfg.image_style));
  const stamp = Date.now().toString(36);
  await instanceService.updateStep(instance.id, 'images', { status: 'running', startedAt: new Date().toISOString(), error: null });
  const images = [];
  for (let i = 0; i < finalPrompts.length; i += 1) {
    const buf = await providers.llm.generateImage({ prompt: finalPrompts[i], size });
    const up = await providers.storage.uploadMedia(folder, buildMediaName('img', stamp, i, 'png'), 'image/png', buf);
    images.push({ driveId: up.id, url: up.downloadUrl, prompt: finalPrompts[i] });
  }
  await instanceService.updateStep(instance.id, 'images', { status: 'done', artifacts: { images }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'images', costImages({ count: images.length, size }));
  return images;
}

/** Animate the already-generated stills, with an optional prompt override. */
async function manualAnimate(ctx, promptOverride) {
  const { instance, cfg, resolved, providers } = ctx;
  const folder = cfg.drive_folder_id || resolved.driveFolder || '';
  const images = stepArtifacts(instance, 'images').images || [];
  if (!images.length) throw new Error('no images to animate — run Images first');
  const anim = createAnimationProvider(resolveAnimationConfig(cfg), log);
  const stamp = Date.now().toString(36);
  const override = String(promptOverride || '').trim();
  await instanceService.updateStep(instance.id, 'animate', { status: 'running', startedAt: new Date().toISOString(), error: null });
  const clips = [];
  for (let i = 0; i < images.length; i += 1) {
    const clipUrl = await anim.animateAndWait({ imageUrl: images[i].url, prompt: override || images[i].prompt });
    const buf = await fetchBuffer(clipUrl);
    const up = await providers.storage.uploadMedia(folder, buildMediaName('clip', stamp, i, 'mp4'), 'video/mp4', buf);
    clips.push({ driveId: up.id, url: up.downloadUrl, sourceImageId: images[i].driveId });
  }
  await instanceService.updateStep(instance.id, 'animate', { status: 'done', artifacts: { clips }, finishedAt: new Date().toISOString() });
  await instanceService.recordCost(instance.id, 'animate', costAnimation({ provider: anim.provider, seconds: totalClipSeconds(cfg.clip_length, clips.length) }));
  return clips;
}

async function manualTranscript(ctx) {
  const { instance, providers } = ctx;
  const audioDriveId = stepArtifacts(instance, 'voiceover').audio?.driveId;
  if (!audioDriveId) throw new Error('no voiceover to transcribe — run Voiceover first');
  const audioBuffer = await providers.storage.download(audioDriveId);
  return runTranscript(ctx, audioBuffer, audioDriveId);
}

async function manualStitch(ctx) {
  const { instance, providers } = ctx;
  const clips = stepArtifacts(instance, 'animate').clips || [];
  if (!clips.length) throw new Error('no clips to stitch — run Image → video first');
  const audioDriveId = stepArtifacts(instance, 'voiceover').audio?.driveId;
  const audioBuffer = audioDriveId ? await providers.storage.download(audioDriveId) : null;
  const cues = stepArtifacts(instance, 'transcript').cues || [];
  return runStitch(ctx, clips, audioBuffer, cues);
}

/**
 * Execute ONE stage for a manual run and persist its artifact — no auto-advance.
 * Editable inputs: script.text (save edited script) or script.correction (regen);
 * images.prompts[]; animate.prompt; publish.caption. On error the step is marked
 * failed but the instance stays 'manual', so the operator can edit and retry.
 */
export async function executeManualStage({ instanceId, stepKey, input = {} }) {
  const ctx = await loadContext(instanceId);
  try {
    if (stepKey === 'script') {
      if (input.text && input.text.trim()) {
        await instanceService.updateStep(instanceId, 'script', { status: 'done', artifacts: { text: input.text.trim() }, error: null, finishedAt: new Date().toISOString() });
      } else {
        await generateScript({ instanceId, correction: input.correction || '' });
      }
    } else if (stepKey === 'images') {
      await manualImages(ctx, input.prompts);
    } else if (stepKey === 'animate') {
      await manualAnimate(ctx, input.prompt);
    } else if (stepKey === 'voiceover') {
      await runVoiceover(ctx);
    } else if (stepKey === 'transcript') {
      await manualTranscript(ctx);
    } else if (stepKey === 'stitch') {
      await manualStitch(ctx);
    } else if (stepKey === 'publish') {
      const refs = await postInstance({ instanceId, captionOverride: input.caption });
      await instanceRepo.lockAsPosted(instanceId, { postRefs: refs, postedAt: new Date() });
      await instanceRepo.setStatus(instanceId, 'posted');
    } else {
      throw new Error(`unknown stage ${stepKey}`);
    }
    return { ok: true };
  } catch (err) {
    log.error({ err: err.message, instance: instanceId, step: stepKey }, 'manual stage failed');
    try {
      await instanceService.updateStep(instanceId, stepKey, { status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
    } catch { /* best effort */ }
    return { ok: false, error: err.message };
  }
}

/** Register the pipeline hooks so review decisions drive generation. */
export function registerPipeline() {
  review.setPipelineHooks({
    afterScriptApprove: runStages,
    beforeFinalLock: postInstance,
    regenerate,
  });
  log.info('stage runner pipeline hooks registered');
}

export default {
  generateScript,
  runScriptAndReview,
  runStages,
  postInstance,
  regenerate,
  executeManualStage,
  registerPipeline,
};
