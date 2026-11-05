/**
 * Ready-video direct post service.
 *
 * Purpose:      The "pick already-made videos from the funnel's Drive folder and
 *               post them directly via Post-for-Me" path: bypassing the whole
 *               generation pipeline (research/script/images/animate/voiceover/
 *               transcript/stitch). The operator tick-selects unposted videos,
 *               gives each a caption and a schedule, and they post in selection
 *               order. No review email (the video is finished), a posted-summary
 *               email is sent afterwards. Each post is recorded as a posted
 *               instance so it shows in the same log, with its stages marked
 *               skipped and zero AI cost.
 *
 *               AI-copy lane, in stages, each video one instance:
 *                 prepare (✂ Clean, optional) → transcript (Whisper with the
 *                 glossary, or a pasted SRT; stops at 'transcript_review' until
 *                 the operator approves it) → AI copy + thumbnails (only from an
 *                 approved transcript) → review & schedule → posted.
 *               Regenerating the copy never re-runs the transcription.
 * Responsibility: Orchestration + side effects; pure logic in utils/readyPostSpec
 *               and utils/aiCopySpec.
 * Dependencies: funnelsRepository, instanceService, instanceRepository,
 *               providerFactory, publishProvider, storageProvider, instanceSpec,
 *               utils/{readyPostSpec,reviewSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceService from '../services/instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as stepLog from './stepLogService.js';
import * as routerDays from '../repositories/routerDaysRepository.js';
import { routerClash, rerunAction } from '../utils/routerSpec.js';
import { DateTime } from 'luxon';
import * as sourcesRepo from '../repositories/funnelSourcesRepository.js';
import { buildProviders } from './providerFactory.js';
import * as heartbeat from '../core/heartbeat.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { createTranscriptProvider } from '../providers/transcriptProvider.js';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import { createGoogleDriveProvider } from '../providers/storageProvider.js';
import { createPublicDriveProvider, publicDlUrl } from '../providers/publicDriveProvider.js';
import * as captureRules from './captureRules.js';
import * as firstComment from './firstCommentService.js';
import * as digest from './digestService.js';
import * as firstCommentsRepo from '../repositories/firstCommentsRepository.js';
import { buildInitialSteps, patchStep, addCostToSteps, sumInstanceCost } from '../utils/instanceSpec.js';
import { costText, costTranscript, costImages } from '../utils/pricing.js';
import { copySystemPrompt, copyUserPrompt, normalizeCopy, platformConfigsFor, platformKey, nextImagePrompt } from '../utils/aiCopySpec.js';
import { THUMB_SPECS, THUMB_SIZES, PLATFORM_SIZE, THUMB_ACCENT, THUMB_ART_SIZE, thumbSvg, thumbArt, thumbImagePrompt } from '../utils/thumbSpec.js';
import { comparisonFor, comparisonHeadline, comparisonSvg, isNoSpeech, parseComparisons } from '../utils/comparisonSpec.js';
import { DEFAULT_COMPARISONS } from '../utils/comparisonFacts.js';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCleanOpts, normalizeEndCard, endCardSvg, cleanVideoArgs, cleanWithCardArgs, progressPct, transcriptSrt, clipSrt, parseSrt, captionSampleTimes, captionsVerdict, routerCleanOpts, autoCheckTimes, autoCleanFromFrames, normalizeScheduleClean, cleanFixPlan, swapMediaUrl } from '../utils/cleanSpec.js';
import { writeFile } from 'node:fs/promises';
import * as driveConnect from './driveConnectService.js';
import { signTicket, peekTicket, readTicket, dispatchRequest, normalizeRunner, keepSecFor, DEFAULT_REPO } from '../utils/cleanHookSpec.js';
import { TRANSCRIPT_REVIEW, postOutcome, mergeChannels, channelOutcome, channelText, nextAutoRetry, requestFromPost, canGenerateCopy, readyStage, prepareTranscript, glossaryTerms, whisperPrompt } from '../utils/laneSpec.js';
import { formatIst } from '../utils/time.js';
import {
  filterReadyVideos,
  defaultCaption,
  defaultSlotsIso,
  postTimeIso,
  normalizeSelections,
  normalizePickedAccounts,
  parseDriveFolderId,
} from '../utils/readyPostSpec.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'readyPost' });

async function loadFunnel(funnelId, pickedAccounts = null) {
  const funnel = await funnels.get(Number(funnelId));
  if (!funnel) throw new Error(`funnel ${funnelId} not found`);
  const resolved = await funnels.resolve(funnel);
  const cfg = await funnels.getConfig(funnel.id).catch(() => ({}));
  // Accounts ticked on the posting page win, and are remembered on the funnel
  // (no funnel setup step needed).
  const picked = normalizePickedAccounts(pickedAccounts);
  if (picked.length) {
    resolved.accounts = picked.map((a) => a.id);
    resolved.accountMap = Object.fromEntries(picked.map((a) => [a.id, { platform: a.platform, account_name: a.name }]));
    await funnels.setConfig(funnel.id, 'postforme_accounts', JSON.stringify(resolved.accounts));
    await funnels.setConfig(funnel.id, 'account_map', JSON.stringify(resolved.accountMap));
  }
  return { funnel, resolved, cfg };
}

/** The Drive folder that holds a funnel's ready videos (direct-upload override,
 *  else the funnel media folder). A pasted folder link becomes its ID. */
function readyFolder(cfg, resolved) {
  const raw = String((cfg && cfg.direct_drive_folder) || resolved.driveFolder || '').trim();
  return parseDriveFolderId(raw) || raw;
}

/** The default caption for this funnel's direct posts. */
function captionFor(cfg, resolved) {
  return defaultCaption({ directCaption: cfg && cfg.direct_caption, audiencePrefix: resolved.audiencePrefix, ctaLink: resolved.ctaLink });
}

/**
 * The Drive client for a ready-video action: the operator's own sign-in token
 * when the files were picked with "Sign in with Google", else the workspace
 * service account when one is set, else the no-key public reader (the folder
 * is shared "Anyone with the link").
 */
function driveFor(providers, accessToken) {
  if (accessToken) return createGoogleDriveProvider({ accessToken }, log);
  const g = providers.resolved.google || {};
  return g.serviceAccount ? providers.storage : createPublicDriveProvider(log);
}

/**
 * The videos to show: the files picked with the Google Drive picker (`picked`),
 * else the unposted videos in a Drive folder, newest first, the folder the
 * operator pasted on the page (`folder`), else the funnel's ready-videos folder.
 * Also returns the picker settings, the service-account email a folder must be
 * shared with, and the Drive error (if listing failed) so the page can say
 * what's wrong.
 */
export async function listReadyVideos({ tenantId = 'default', funnelId, folder: override = '', picked = [] }) {
  const { funnel, resolved, cfg } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const sources = await sourcesRepo.listByFunnel(funnel.id).catch(() => []);
  const firstFolder = (sources.find((x) => x.type === 'drive_folder') || {}).ref || '';
  const folder = override || readyFolder(cfg, resolved) || firstFolder;
  const g = providers.resolved.google || {};
  const saEmail = (g.serviceAccount && g.serviceAccount.client_email) || '';
  const picker = { clientId: g.oauthClientId || '', apiKey: g.pickerApiKey || '', appId: g.projectNumber || '' };
  const base = { funnel, resolved, cfg, folder, saEmail, picker, sources, source: { type: 'drive_pick', id: null }, defaultCaption: captionFor(cfg, resolved) };
  if (picked && picked.length) {
    const drafts = await loadDrafts(funnel, picked.map((f) => f.id));
    return { ...base, folder: '', picked: true, videos: picked, drafts, comparison: await comparisonState({ funnel, videos: picked, drafts }) };
  }
  if (!folder) return { ...base, videos: [] };
  let files;
  try {
    files = await driveFor(providers, '').listFiles(folder);
  } catch (err) {
    log.warn({ err: err.message, folder }, 'ready folder list failed');
    return { ...base, videos: [], listError: err.message };
  }
  // Posted files are hidden by the app's own record too, a public folder
  // can't be renamed "POSTED".
  const posted = new Set(await instanceRepo.postedDriveIds(funnel.id, funnel.tenant_id).catch(() => []));
  // A folder that lists is saved as one of the funnel's sources.
  const saved = await sourcesRepo.upsert({ tenantId: funnel.tenant_id, funnelId: funnel.id, type: 'drive_folder', ref: folder, label: `Drive folder …${folder.slice(-6)}` }).catch((err) => {
    log.warn({ err: err.message }, 'source save failed');
    return null;
  });
  if (saved && !sources.some((x) => String(x.id) === String(saved.id))) sources.push(saved);
  base.source = { type: 'drive_folder', id: saved ? saved.id : null };
  const videos = filterReadyVideos(files)
    .filter((f) => !posted.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime }))
    .sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));
  const drafts = await loadDrafts(funnel, videos.map((v) => v.id));
  return { ...base, videos, totalFiles: files.length, drafts, comparison: await comparisonState({ funnel, videos, drafts }) };
}

/**
 * One ready-video instance as its own stage view: the same panels as the
 * Prepare list, for just this video.
 */
export async function instanceView(row) {
  const { funnel, resolved, cfg } = await loadFunnel(row.funnel_id);
  const steps = instanceService.parseSteps(row);
  const video = ((steps.find((x) => x.key === 'stitch') || {}).artifacts || {}).video || {};
  const driveId = row.source_ref || video.driveId;
  if (!driveId) throw new Error('this instance has no source video');
  const drafts = await loadDrafts(funnel, [driveId]);
  if (!drafts[driveId]) {
    const d = draftView(row);
    if (d) drafts[driveId] = d;
  }
  const when = row.scheduled_for && new Date(row.scheduled_for) > new Date() ? formatIst(row.scheduled_for) : '';
  return {
    funnel, resolved, cfg, single: row,
    prefills: [when || formatIst(defaultSlotsIso(resolved.publishTime, 1)[0])],
    source: { type: row.source_type || 'drive_folder', id: row.source_id || null },
    videos: [{ id: driveId, name: video.name || row.title || driveId }],
    drafts,
    comparison: await comparisonState({ funnel, videos: [{ id: driveId, name: video.name || row.title || '' }], drafts }),
    defaultCaption: captionFor(cfg, resolved),
  };
}

/** Forget one of the funnel's saved sources (its instances keep their history). */
export async function removeSource({ funnelId, sourceId }) {
  return sourcesRepo.remove(Number(funnelId), Number(sourceId));
}

// Video lengths by Drive id, a file's length never changes, so probe once.
const durationCache = new Map();

/**
 * Lengths (seconds) of public Drive videos, read with ffprobe from the public
 * download URL, a few at a time. { driveId: seconds }; 0 = unknown.
 */
export async function videoDurations(driveIds) {
  const ids = [...new Set((Array.isArray(driveIds) ? driveIds : []).map(String).filter((id) => /^[\w-]{10,}$/.test(id)))].slice(0, 60);
  const ffmpeg = createFfmpegProvider({}, log);
  const out = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      if (!durationCache.has(id)) {
        const sec = Math.round(await ffmpeg.probeDuration({ url: publicDlUrl(id) }));
        if (sec > 0) durationCache.set(id, sec);
      }
      out[id] = durationCache.get(id) || 0;
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker));
  return out;
}

// Whisper rejects uploads over 25 MB.
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

/** Normalise the page's { type, id } source. */
function sourceOf(source) {
  const o = source && typeof source === 'object' ? source : {};
  const type = ['drive_folder', 'drive_pick'].includes(o.type) ? o.type : 'drive_folder';
  const id = Number(o.id) > 0 ? Number(o.id) : null;
  return { type, id };
}

/**
 * The video's one instance (made when there's none yet), stamped with the
 * source it came from. Returns { inst, steps, existing }.
 */
async function ensureInstance({ funnel, driveId, name = '', title = 'Ready video', source = null }) {
  const src = sourceOf(source);
  const existing = await workingRow(funnel, driveId);
  if (existing) {
    if (!existing.source_type || !existing.source_ref || (!existing.source_id && src.id)) {
      await instanceRepo.setSource(existing.id, {
        sourceType: existing.source_type ? undefined : src.type,
        sourceId: existing.source_id ? undefined : src.id,
        sourceRef: driveId,
      });
    }
    let steps = instanceService.parseSteps(existing);
    if (name && !videoArt(steps, driveId).name) steps = patchStep(steps, 'stitch', { artifacts: { video: { ...videoArt(steps, driveId), name } } });
    return { inst: existing, steps, existing: true };
  }
  const inst = await instanceService.createForFunnel({
    tenantId: funnel.tenant_id, funnel, title, status: 'draft', sourceType: src.type, sourceId: src.id, sourceRef: driveId,
  });
  let steps = buildInitialSteps();
  for (const k of ['animate', 'voiceover']) steps = patchStep(steps, k, { status: 'skipped' });
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { driveId, ...(name ? { name } : {}) } } });
  return { inst, steps, existing: false };
}

/** Run one step of a known instance, logging its time. fn calls begin(instanceId) once it knows the row. */
async function timedStep(key, fn) {
  let id = null;
  const begin = (instanceId) => {
    id = instanceId;
    return stepLog.start(instanceId, key);
  };
  try {
    const out = await fn(begin);
    if (id) await stepLog.end(id, key);
    return out;
  } catch (err) {
    if (id) await stepLog.fail(id, key);
    throw err;
  }
}

/**
 * Stage 2a: transcribe one ready video (Whisper, with the glossary as its
 * prompt) and stop: the instance waits in 'transcript_review' until the
 * operator approves the text. Nothing paid runs after this.
 */
export async function transcribeVideo(args) {
  return timedStep('transcript', (begin) => transcribeBody(args, begin));
}

async function transcribeBody({ tenantId = 'default', funnelId, driveId, name = '', accessToken = '', source = null }, begin) {
  if (!driveId) throw new Error('driveId required');
  const id = String(driveId);
  const { funnel } = await loadFunnel(funnelId);
  const startedAt = new Date().toISOString();
  const prior = (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [id]).catch(() => ({})))[id];
  if (prior) await begin(prior.id);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const ext = ((String(name).match(/\.(\w{2,4})$/) || [])[1] || 'mp4').toLowerCase();
  const ffmpeg = createFfmpegProvider({}, log);
  const video = await driveFor(providers, accessToken).download(id);
  const audio = await ffmpeg.extractAudio({ videoBuffer: video, ext });
  let text = '';
  let cues = [];
  let cost = null;
  if (audio.length) {
    if (audio.length > WHISPER_MAX_BYTES) throw new Error('video audio is too long to transcribe (over ~70 minutes)');
    const tp = createTranscriptProvider({ apiKey: providers.resolved.transcriptKey || providers.resolved.openai.apiKey }, log);
    const t = await tp.transcribe({ buffer: audio, filename: 'audio.mp3', prompt: whisperPrompt(providers.resolved.prompts?.glossary) });
    text = t.text;
    cues = t.cues || [];
    if (t.durationSeconds > 0) durationCache.set(id, Math.round(t.durationSeconds));
    cost = { ...costTranscript({ provider: tp.provider, minutes: t.minutes }), at: new Date().toISOString() };
  }
  // Only the transcript fields change: the headline, sub-head and image prompt are the operator's and stay as they are.
  const { inst, steps: base } = await ensureInstance({ funnel, driveId: id, name, source });
  let steps = patchStep(base, 'transcript', {
    status: 'done',
    artifacts: { text, cues, srt: '', source: 'whisper', approvedAt: null },
    finishedAt: new Date().toISOString(), error: null,
  });
  if (cost) steps = addCostToSteps(steps, 'transcript', { ...cost, costUsd: Number(cost.costUsd) || 0 });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setStatus(inst.id, TRANSCRIPT_REVIEW);
  await (prior ? stepLog.end(inst.id, 'transcript') : stepLog.span(inst.id, 'transcript', startedAt));
  await stepLog.start(inst.id, 'review_transcript');
  const durationSec = durationCache.get(id) || 0;
  if (durationSec) await instanceRepo.setMeta(inst.id, { durationSeconds: durationSec });
  log.info({ funnel: funnel.name, driveId: id, words: text.split(/\s+/).filter(Boolean).length }, 'ready video transcribed (awaiting approval)');
  return {
    instanceId: inst.id, transcript: text, transcribed: audio.length > 0,
    costs: cost ? [{ step: 'transcript', ...cost }] : [], stage: 'transcript',
  };
}

// 🎙 Transcribe jobs by Drive id: { state: running | done | failed, result?, error? }. The
// result is saved on the instance by transcribeVideo, so a restart only loses the status.
const transcribeJobs = new Map();

/** Start transcribing in the background (no page needs to stay open). */
export function startTranscribe(args) {
  const id = String(args.driveId || '');
  if (!id) throw new Error('driveId required');
  const job = transcribeJobs.get(id);
  if (job && job.state === 'running') return job;
  const running = { state: 'running', startedAt: Date.now() };
  transcribeJobs.set(id, running);
  heartbeat.during('transcribe', () => transcribeVideo(args))
    .then((result) => transcribeJobs.set(id, { state: 'done', result }))
    .catch((err) => {
      // Some errors (a refused DB or network connection) carry no message: say what they are instead.
      const inner = Array.isArray(err && err.errors) ? err.errors.map((e) => e && (e.message || e.code)).filter(Boolean).join('; ') : '';
      const why = (err && err.message) || inner || (err && (err.code || err.name)) || String(err) || 'unknown error';
      log.error({ err: why, code: err && err.code, stack: err && err.stack, driveId: id }, 'transcribe failed');
      transcribeJobs.set(id, { state: 'failed', error: why });
    });
  return running;
}

/** Where a transcribe job stands ('none' when there is none in memory). */
export function transcribeStatus({ driveId }) {
  return transcribeJobs.get(String(driveId)) || { state: 'none' };
}

/**
 * Stage 2b: keep the operator's transcript: edited text, or a pasted SRT
 * (cue numbers + timestamps stripped for the LLM, the raw SRT kept for
 * captions). `approve` passes the gate; a changed text without it needs
 * approving again. One video at a time, there is no bulk approve.
 */
export async function saveTranscript({ funnelId, driveId, name = '', text = '', headline = '', subhead = '', imagePrompt = '', approve = false, source = null }) {
  if (!driveId) throw new Error('driveId required');
  const id = String(driveId);
  const { funnel } = await loadFunnel(funnelId);
  const { inst, steps: base } = await ensureInstance({ funnel, driveId: id, name, source });
  const prev = ((base.find((x) => x.key === 'transcript') || {}).artifacts) || {};
  const next = prepareTranscript(text);
  const head = String(headline || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sub = String(subhead || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prompt = String(imagePrompt || '').trim().slice(0, 1500);
  if (approve && !next.text) {
    const providers = await buildProviders(funnel.tenant_id || 'default');
    if (!comparisonFor({ settings: providers.resolved.comparison, name, choice: prev.comparison })) throw new Error('The transcript is empty: transcribe the video, or type / paste the text, first');
  }
  const unchanged = next.text === String(prev.text || '').trim();
  const srt = next.srt || (unchanged ? prev.srt || '' : '');
  const approvedAt = approve ? new Date().toISOString() : (unchanged ? prev.approvedAt || null : null);
  const steps = patchStep(base, 'transcript', {
    status: 'done',
    artifacts: {
      text: next.text, srt, cues: unchanged ? prev.cues || [] : [],
      source: unchanged ? prev.source || 'edited' : (next.srt ? 'srt' : 'edited'), approvedAt,
      headline: head, subhead: sub, imagePrompt: prompt,
    },
  });
  const status = approvedAt ? 'draft' : TRANSCRIPT_REVIEW;
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setStatus(inst.id, status);
  if (approve) await stepLog.end(inst.id, 'review_transcript', { by: 'approved' });
  return {
    instanceId: inst.id, transcript: next.text, srt: !!srt, timed: !!transcriptSrt({ srt, cues: unchanged ? prev.cues : [] }), approved: !!approvedAt,
    approvedIst: approvedAt ? formatIst(approvedAt) : '', stage: readyStage({ status }, steps),
  };
}

/**
 * Stage 3: write one video's copy from its APPROVED transcript (read from the
 * instance, never from the page). Regenerating never re-runs the
 * transcription. `withThumbs` also makes the thumbnails (the daily router);
 * the page makes them with their own button, so there the saved thumbnails
 * are kept as they are. Returns { copy, transcript, costs, ... }: costs are
 * the real token / image costs, recorded on the instance.
 */
export async function generateCopy(args) {
  return timedStep('copy', (begin) => writeCopy(args, begin));
}

async function writeCopy({ tenantId = 'default', funnelId, driveId, name = '', accessToken = '', accounts: pickedAccounts = null, withThumbs = true, note = '' }, begin) {
  if (!driveId) throw new Error('driveId required');
  const { funnel, resolved, cfg } = await loadFunnel(funnelId, pickedAccounts);
  const draft = (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [String(driveId)]))[String(driveId)];
  const draftSteps = draft ? instanceService.parseSteps(draft) : [];
  if (!draft || !canGenerateCopy(draftSteps)) throw new Error('Approve the transcript first: the copy is written only from an approved transcript');
  await begin(draft.id);
  const tArt = ((draftSteps.find((x) => x.key === 'transcript') || {}).artifacts) || {};
  const transcript = String(tArt.text || '');
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const costs = [];
  const ext = ((String(name).match(/\.(\w{2,4})$/) || [])[1] || 'mp4').toLowerCase();
  const comparison = comparisonFor({ settings: providers.resolved.comparison, name, transcript, choice: tArt.comparison });

  const { data, model, usage } = await providers.llm.generateJsonDetailed({
    system: copySystemPrompt({ brief: cfg && cfg.direct_copy_brief, audience: resolved.audiencePrefix, keyword: resolved.captureKeyword, base: providers.resolved.prompts.copy, comparison: !!comparison, comparisonPrompt: providers.resolved.prompts.comparison }),
    user: copyUserPrompt({ transcript, fileName: name, glossary: glossaryTerms(providers.resolved.prompts?.glossary), comparison, note }),
    maxTokens: 8000,
  });
  costs.push({ step: 'script', ...costText({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model }) });
  const copy = normalizeCopy(data);
  if (!copy.title && !copy.description) throw new Error('the model returned empty copy, try again');
  log.info({ funnel: funnel.name, driveId, words: transcript.split(/\s+/).filter(Boolean).length }, 'ready video copy generated');

  // Copy only: the thumbnails already on the instance stay as they are.
  const saved = ((draftSteps.find((x) => x.key === 'images') || {}).artifacts) || {};
  const lastCopy = ((draftSteps.find((x) => x.key === 'script') || {}).artifacts || {}).copy || {};
  const imagePromptWas = String(tArt.imagePrompt || '');
  const imagePrompt = nextImagePrompt(imagePromptWas, lastCopy.thumbPrompt, copy.thumbPrompt);
  // A thumbnail failure never loses the copy; the video's first frame is used instead.
  const { thumbs, sizes, thumbError } = withThumbs
    ? await makeThumbs({
      providers, resolved, driveId, ext, accessToken, costs, comparison,
      imagePrompt: imagePrompt || copy.title, text: comparison ? tArt.headline || '' : tArt.headline || copy.thumbText || copy.title, sub: tArt.subhead || '',
    })
    : { thumbs: saved.thumbs || {}, sizes: saved.sizes || [], thumbError: '' };
  const instanceId = await saveDraft({ funnel, driveId, copy, thumbs, sizes, thumbError, costs, keepThumbs: !withThumbs }).catch((err) => {
    log.warn({ err: err.message, driveId }, 'draft save failed (generation still returned)');
    return null;
  });
  // The copy also writes an image prompt: it never replaces one you wrote.
  if (imagePrompt !== imagePromptWas.trim()) {
    try {
      const { inst, steps: base } = await ensureInstance({ funnel, driveId: String(driveId), name });
      const steps = patchStep(base, 'transcript', { artifacts: { imagePrompt } });
      await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
    } catch (err) {
      log.warn({ err: err.message, driveId }, 'image prompt not saved (still returned)');
    }
  }
  return { copy, transcript, costs, thumbs, sizes, thumbError, instanceId, imagePrompt, imagePromptWas, stage: 'review' };
}

/**
 * Thumbnails: one AI artwork (else a frame of the video), rendered in each size
 * the funnel's platforms need with the operator's headline. Never throws: a
 * failure comes back as thumbError. Image costs are pushed onto `costs`.
 */
async function makeThumbs({ providers, resolved, driveId, ext = 'mp4', accessToken = '', costs, imagePrompt, text, sub = '', comparison = null }) {
  const ffmpeg = createFfmpegProvider({}, log);
  let video = null; // downloaded only when a non-public file needs it for the frame
  const getVideo = async () => video || (video = await driveFor(providers, accessToken).download(driveId));
  let thumbs = {};
  let sizes = [];
  let thumbError = '';
  try {
    const platforms = thumbPlatforms(resolved);
    // A comparison is drawn from its facts: no AI picture, no cost, no people.
    if (comparison) {
      const logo = await comparisonLogo(comparison.logo);
      const headline = comparisonHeadline(text);
      const draw = (spec) => sharp(Buffer.from(comparisonSvg({ ...spec, ...comparison, headline, logo }))).jpeg({ quality: 88 }).toBuffer();
      ({ thumbs, sizes } = await renderThumbs({ providers, platforms, draw }));
      return { thumbs, sizes, thumbError };
    }
    const imageModel = /^gpt-image/.test(String(providers.resolved.openai?.imageModel || '')) ? providers.resolved.openai.imageModel : 'gpt-image-1';
    let base = null;
    try {
      base = await providers.llm.generateImage({ prompt: thumbImagePrompt(imagePrompt, providers.resolved.prompts?.thumbnail, text), size: THUMB_ART_SIZE, model: imageModel });
      costs.push({ step: 'images', ...costImages({ count: 1, size: THUMB_ART_SIZE, model: imageModel }) });
    } catch (err) {
      log.warn({ err: err.message }, 'thumbnail artwork failed (using a video frame)');
      thumbError = `artwork: ${err.message}`;
    }
    if (!base) {
      base = video
        ? await ffmpeg.extractFrame({ videoBuffer: video, ext })
        : await ffmpeg.extractFrame({ url: publicDlUrl(driveId) }).catch(async () => ffmpeg.extractFrame({ videoBuffer: await getVideo(), ext }));
    }
    // The operator's headline + sub-head (typed at the transcript stage) go on the image.
    ({ thumbs, sizes } = await renderThumbs({ providers, platforms, base, text, sub }));
  } catch (err) {
    thumbError = err.message;
    log.warn({ err: err.message, driveId }, 'thumbnail generation failed (first frame will be used)');
  }
  return { thumbs, sizes, thumbError };
}

/**
 * 🖼 Thumbnail only: render the thumbnails from the operator's headline,
 * sub-head and image prompt WITHOUT writing or touching any copy, for a video
 * whose copy was written by hand. Needs no approved transcript, only a
 * headline. The headline / sub-head / prompt used are kept on the transcript
 * step (its text and approval untouched); the thumbnails on the images step.
 */
export async function generateThumbnail({ tenantId = 'default', funnelId, driveId, name = '', accessToken = '', accounts: pickedAccounts = null, headline, subhead, imagePrompt, source = null }) {
  if (!driveId) throw new Error('driveId required');
  const id = String(driveId);
  const { funnel, resolved } = await loadFunnel(funnelId, pickedAccounts);
  const { inst, steps: base } = await ensureInstance({ funnel, driveId: id, name, source });
  const tArt = ((base.find((x) => x.key === 'transcript') || {}).artifacts) || {};
  const copy = ((base.find((x) => x.key === 'script') || {}).artifacts || {}).copy || {};
  const head = String(headline ?? tArt.headline ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sub = String(subhead ?? tArt.subhead ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const prompt = String(imagePrompt ?? tArt.imagePrompt ?? '').trim().slice(0, 1500);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const comparison = comparisonFor({ settings: providers.resolved.comparison, name, transcript: tArt.text, choice: tArt.comparison });
  if (!head && !comparison) throw new Error('Type the thumbnail headline first');
  const costs = [];
  const ext = ((String(name).match(/\.(\w{2,4})$/) || [])[1] || 'mp4').toLowerCase();
  const { thumbs, sizes, thumbError } = await makeThumbs({ providers, resolved, driveId: id, ext, accessToken, costs, imagePrompt: prompt || copy.thumbPrompt || copy.title || head, text: head, sub, comparison });
  let steps = patchStep(base, 'transcript', { artifacts: { headline: head, subhead: sub, imagePrompt: prompt } });
  if (sizes.length) steps = patchStep(steps, 'images', { status: 'done', artifacts: { thumbs, sizes } });
  const at = new Date().toISOString();
  for (const { step, ...c } of costs) steps = addCostToSteps(steps, 'images', { ...c, costUsd: Number(c.costUsd) || 0, at });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  log.info({ funnel: funnel.name, driveId: id, sizes: sizes.length }, 'ready video thumbnail generated (copy untouched)');
  return { thumbs, sizes, thumbError, costs, instanceId: inst.id };
}

/**
 * Render the artwork in each size the funnel's platforms need (cover crop + the
 * hook headline) and upload it to Post for Me. Returns { thumbs: platform ->
 * url, sizes: [{ size, label, url, platforms }] }.
 */
async function renderThumbs({ providers, platforms, base, text, sub = '', draw = null }) {
  const postformeKey = providers.resolved.postformeKey || '';
  if (!postformeKey) throw new Error('No Post for Me API key, set it under Setup → Keys and credit');
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);
  const thumbs = {};
  const sizes = [];
  for (const [size, spec] of Object.entries(THUMB_SIZES)) {
    const users = platforms.filter((k) => PLATFORM_SIZE[k] === size);
    if (!users.length) continue;
    const jpg = draw ? await draw(spec) : await composeThumb(base, spec, { text, sub });
    const url = await publish.uploadMedia(jpg, 'image/jpeg');
    for (const k of users) thumbs[k] = url;
    sizes.push({ size, label: spec.label, url, platforms: users });
  }
  log.info({ sizes: sizes.map((x) => x.label) }, 'thumbnails rendered + uploaded');
  return { thumbs, sizes };
}

/** The Settings logo link as a data: URI for the drawn thumbnail; '' (the name is typed) when it can't be read. */
async function comparisonLogo(link) {
  const url = String(link || '').trim();
  if (!url) return '';
  try {
    const driveId = (url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]{10,})/) || [])[1];
    const res = await fetch(driveId ? publicDlUrl(driveId) : url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const png = await sharp(Buffer.from(await res.arrayBuffer())).resize({ height: 300, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    log.warn({ err: err.message }, 'comparison logo not readable (typing the name instead)');
    return '';
  }
}

/** For the video page: the competitors to pick from, and what each video is now. */
async function comparisonState({ funnel, videos, drafts }) {
  const { resolved } = await buildProviders(funnel.tenant_id || 'default');
  const settings = resolved.comparison;
  const byVideo = {};
  for (const v of videos) {
    const d = drafts[v.id] || {};
    byVideo[v.id] = { choice: d.comparison || '', active: comparisonFor({ settings, name: v.name, transcript: d.transcript, choice: d.comparison }) };
  }
  return { names: parseComparisons(settings.list || DEFAULT_COMPARISONS).map((c) => c.competitor), byVideo };
}

/** The video page's comparison choice: blank = detect, off = normal video, or a competitor. */
export async function setComparison({ tenantId = 'default', funnelId, driveId, name = '', choice = '', source = null }) {
  if (!driveId) throw new Error('driveId required');
  const { funnel } = await loadFunnel(funnelId);
  const { inst, steps: base } = await ensureInstance({ funnel, driveId: String(driveId), name, source });
  const picked = String(choice || '').slice(0, 80);
  const steps = patchStep(base, 'transcript', { artifacts: { comparison: picked } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const tArt = ((steps.find((x) => x.key === 'transcript') || {}).artifacts) || {};
  return { instanceId: inst.id, choice: picked, active: comparisonFor({ settings: providers.resolved.comparison, name, transcript: tArt.text, choice: picked }) };
}

/** The transcript already saved on this video, so the router neither pays again nor overwrites pasted text. */
export async function savedTranscript({ funnelId, driveId }) {
  const { funnel } = await loadFunnel(funnelId);
  const row = (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [String(driveId)]))[String(driveId)];
  if (!row) return null;
  const text = String(((instanceService.parseSteps(row).find((x) => x.key === 'transcript') || {}).artifacts || {}).text || '');
  return text.trim() ? { instanceId: row.id, transcript: text } : null;
}

/** Videos the router must leave alone: no speech found, nobody added text, and they are not comparisons. */
export async function silentDriveIds({ funnel, resolved, files = [] }) {
  const drafts = await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, files.map((f) => String(f.id)));
  return files.filter((f) => {
    const row = drafts[String(f.id)];
    if (!row) return false;
    const steps = instanceService.parseSteps(row);
    if (!isNoSpeech(steps)) return false;
    const choice = ((steps.find((x) => x.key === 'transcript') || {}).artifacts || {}).comparison;
    return !comparisonFor({ settings: resolved.comparison, name: f.name, choice });
  }).map((f) => String(f.id));
}

/**
 * One size. A full-frame size crops the picture to fill it. A narrow one puts
 * the picture on a panel under the headline, over a soft blurred copy of itself.
 */
async function composeThumb(base, spec, { text, sub = '' }) {
  const overlay = { input: Buffer.from(thumbSvg({ ...spec, accent: THUMB_ACCENT, text, sub })) };
  const art = thumbArt(spec);
  if (!art) return sharp(base).resize(spec.w, spec.h, { fit: 'cover' }).composite([overlay]).jpeg({ quality: 90 }).toBuffer();
  const panel = await sharp(base).resize(art.w, art.h, { fit: 'cover' }).toBuffer();
  return sharp(base)
    .resize(spec.w, spec.h, { fit: 'cover' })
    .blur(40)
    .modulate({ brightness: 0.75 })
    .composite([{ input: panel, top: art.top, left: 0 }, overlay])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The platforms this funnel posts to that have a thumbnail spec (all, if unknown). */
function thumbPlatforms(resolved) {
  const accountMap = resolved.accountMap || {};
  const present = [...new Set((resolved.accounts || []).map((id) => platformKey((accountMap[id] || {}).platform)).filter(Boolean))];
  return (present.length ? present : Object.keys(THUMB_SPECS)).filter((k) => THUMB_SPECS[k]);
}

/** The stitch step's video artifact, keeping what's already there (e.g. the cleaned copy, the file name). */
function videoArt(steps, driveId, durationSec = 0) {
  const prev = ((steps.find((x) => x.key === 'stitch') || {}).artifacts || {}).video || {};
  return { ...prev, driveId, ...(durationSec ? { durationSec } : {}) };
}

// Scheduled videos being re-cleaned, Drive id -> instance id: their clean, subtitles
// and cost belong on that scheduled instance, not on a new draft.
const repairing = new Map();

/** The instance a video's clean and transcript live on: the one being repaired, else its draft. */
async function workingRow(funnel, driveId) {
  const id = String(driveId);
  if (repairing.has(id)) return instanceRepo.get(repairing.get(id));
  return (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [id]))[id];
}

// ✂ Clean jobs by Drive id: { state: running | done | failed, phase, pct, clean?, error? }
//, phase: starting → encoding (download + encode, with pct) → uploading.
// In memory only: a restart loses a running job (just press Clean again);
// a finished one is saved on the video's draft instance.
const cleanJobs = new Map();
// GitHub cleans hold the heartbeat until their done/fail callback (capped, in case it never comes).
const cleanHolds = new Map();
const CLEAN_HOLD_MAX_MS = 60 * 60 * 1000;
function holdClean(driveId) {
  releaseClean(driveId);
  const release = heartbeat.hold('clean');
  const cap = setTimeout(() => releaseClean(driveId), CLEAN_HOLD_MAX_MS);
  cap.unref?.();
  cleanHolds.set(driveId, () => { clearTimeout(cap); release(); });
}
function releaseClean(driveId) {
  const release = cleanHolds.get(driveId);
  if (release) { cleanHolds.delete(driveId); release(); }
}

/**
 * Start cleaning one ready video in the background (zoom from the top so the
 * corner watermark leaves the frame, cut the outro), then upload it to Post for
 * Me. The page polls cleanStatus.
 */
export async function startClean({ funnelId, driveId, zoomPct, trimEndSec, endText = '', endLink = '', endSec = 0, subs = false, name = '', source = null, runner = '', baseUrl = '' }) {
  if (!driveId) throw new Error('driveId required');
  const id = String(driveId);
  const { funnel } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id);
  const job = cleanJobs.get(id);
  if (job && job.state === 'running') return job;
  const opts = { ...normalizeCleanOpts({ zoomPct, trimEndSec }), ...normalizeEndCard({ endText, endLink, endSec }) };
  // Subtitles from the transcript, only when it has timestamps and the video doesn't already show subtitles.
  if (subs) Object.assign(opts, await subtitlePlan({ funnel, providers, driveId: id, trimEndSec: opts.trimEndSec, name, source }));
  // GitHub Actions runs ffmpeg and keeps the file in your Drive; Railway is the original path.
  const where = normalizeRunner(runner || (providers.resolved.clean || {}).runner);
  if (where === 'github') return startCleanGithub({ funnel, providers, id, opts, name, source, baseUrl });
  if (!providers.resolved.postformeKey) throw new Error('No Post for Me API key, set it under Setup → Keys and credit');
  const running = { state: 'running', startedAt: Date.now(), phase: 'starting', pct: 0, ...opts };
  cleanJobs.set(id, running);
  const onPhase = (patch) => { const j = cleanJobs.get(id); if (j && j.state === 'running') Object.assign(j, patch); };
  heartbeat.during('clean', () => runClean({ funnel, providers, driveId: id, opts, name, source, onPhase }))
    .then((clean) => cleanJobs.set(id, { state: 'done', clean }))
    .catch((err) => {
      log.error({ err: err.message, driveId: id }, 'video clean failed');
      cleanJobs.set(id, { state: 'failed', error: err.message });
    });
  return running;
}

const NO_TIMED_SRT = "This video's transcript has no timestamps, so there are no subtitles to burn. 🎙 Transcribe it (Whisper keeps the timings) or paste an SRT in step 2, then clean again. Editing the transcribed text drops Whisper's timings.";

const CAPTION_CHECK_SYSTEM = 'You check frames of a short video for subtitles: lines of text at the bottom or middle of the picture that show the words being spoken (burned-in captions). '
  + 'A title, a slide or chart, a logo, a watermark or a name tag is NOT subtitles. '
  + 'Return JSON: {"frames":[{"captions":true|false}, ...]}, one entry per image, in order.';

/**
 * Whether Clean adds subtitles: { subs: true } when the transcript is timed and
 * the video shows none yet; else { subsNote } saying why not (shown with the
 * cleaned video). An AI looks at 3 frames, a check that fails adds none, so
 * subtitles are never doubled. Its small cost is kept on the instance.
 */
async function subtitlePlan({ funnel, providers, driveId, trimEndSec, name, source }) {
  const srt = await videoSrt(funnel, driveId);
  if (!srt) return { subsNote: 'no subtitles added: the transcript has no timestamps (🎙 Transcribe, or paste an SRT)' };
  const url = publicDlUrl(driveId);
  const ffmpeg = createFfmpegProvider({}, log);
  try {
    if ((await ffmpeg.probeVideo({ url })).hasSubtitles) return { subsNote: 'no subtitles added: the video already has a subtitle track' };
    const total = (await videoDurations([driveId]))[driveId] || 0;
    const frames = [];
    // Frames taken mid-speech, where any existing subtitles would be on screen.
    for (const atSec of captionSampleTimes(total, keepSecFor(total, trimEndSec), parseSrt(srt))) {
      const f = await ffmpeg.extractFrame({ url, atSec });
      frames.push(await sharp(f).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer());
    }
    const r = await providers.llm.generateJsonDetailed({ system: CAPTION_CHECK_SYSTEM, user: `${frames.length} frames of the video, in order.`, images: frames, maxTokens: 1500 });
    const cost = costText({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, model: r.model });
    await recordCost(funnel, driveId, 'stitch', cost, { name, source }).catch((err) => log.warn({ err: err.message, driveId }, 'subtitle check cost not saved'));
    const has = captionsVerdict((r.data || {}).frames);
    log.info({ driveId, has, frames: (r.data || {}).frames }, 'on-screen subtitle check');
    return has ? { subsNote: 'no subtitles added: the video already shows subtitles' } : { subs: true };
  } catch (err) {
    log.warn({ err: err.message, driveId }, 'on-screen subtitle check failed (none added)');
    return { subsNote: `no subtitles added: could not check whether the video already has them (${String(err.message).slice(0, 120)})` };
  }
}

/** Add one real cost to a step of the video's instance (made if there's none yet). */
async function recordCost(funnel, driveId, step, cost, { name = '', source = null } = {}) {
  const { inst, steps: base } = await ensureInstance({ funnel, driveId, name, source });
  const steps = addCostToSteps(base, step, { ...cost, costUsd: Number(cost.costUsd) || 0, at: new Date().toISOString() });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
}

/** The video's timed subtitles from its transcript step (pasted SRT or Whisper cues); '' when none. */
async function videoSrt(funnel, driveId) {
  const draft = await workingRow(funnel, driveId).catch(() => null);
  const steps = draft ? instanceService.parseSteps(draft) : [];
  return transcriptSrt(((steps.find((x) => x.key === 'transcript') || {}).artifacts) || {});
}

async function runClean({ funnel, providers, driveId, opts, name, source, onPhase = () => {} }) {
  const total = (await videoDurations([driveId]))[driveId] || 0;
  const keepSec = keepSecFor(total, opts.trimEndSec);
  const dir = await mkdtemp(join(tmpdir(), 'clean-'));
  try {
    const outPath = join(dir, 'clean.mp4');
    const t0 = Date.now();
    const ffmpeg = createFfmpegProvider({}, log);
    const url0 = publicDlUrl(driveId);
    // Subtitles: the transcript's cues up to the cut, burned on the video part only.
    let subPath = '';
    if (opts.subs) {
      const srt = clipSrt(await videoSrt(funnel, driveId), keepSec);
      if (!srt) throw new Error(NO_TIMED_SRT);
      subPath = join(dir, 'subs.srt');
      await writeFile(subPath, srt, 'utf8');
    }
    // End card: black screen + the operator's text and link, after the video.
    let args = null;
    if (opts.endSec > 0) {
      const info = await ffmpeg.probeVideo({ url: url0 });
      const w = info.width || 1080;
      const h = info.height || 1920;
      const card = join(dir, 'card.png');
      await writeFile(card, await sharp(Buffer.from(endCardSvg({ w, h, text: opts.endText, link: opts.endLink }))).png().toBuffer());
      args = cleanWithCardArgs({ input: url0, card, output: outPath, zoomPct: opts.zoomPct, keepSec, cardSec: opts.endSec, w, h, fps: info.fps || 30, hasAudio: info.hasAudio, subPath });
    } else if (subPath) {
      args = cleanVideoArgs({ input: url0, output: outPath, zoomPct: opts.zoomPct, keepSec, subPath });
    }
    const outSec = (keepSec || total) + (opts.endSec || 0);
    onPhase({ phase: 'encoding', pct: 0, totalSec: outSec });
    await ffmpeg.cleanVideo({
      url: url0, outPath, zoomPct: opts.zoomPct, keepSec, args,
      onProgress: (sec) => onPhase({ pct: progressPct(sec, outSec), doneSec: Math.round(sec) }),
    });
    onPhase({ phase: 'uploading', pct: 100 });
    const url = await createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log).uploadFile(outPath, 'video/mp4');
    const clean = { url, ...opts, durationSec: Math.round((keepSec || total) + (opts.endSec || 0)), at: new Date().toISOString() };
    await saveClean(funnel, driveId, clean, { name, source });
    log.info({ driveId, ...opts, seconds: Math.round((Date.now() - t0) / 1000) }, 'video cleaned + uploaded');
    return clean;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * ✂ Clean on GitHub Actions: send the workflow a signed ticket (the only thing
 * it holds). The workflow then calls the clean hooks below with it: job details
 * + a short-lived Drive token, progress, the end-card image, done / failed.
 */
async function startCleanGithub({ funnel, providers, id, opts, name, source, baseUrl }) {
  const tenantId = funnel.tenant_id;
  const c = providers.resolved.clean || {};
  if (!(await driveConnect.status(tenantId)).connected) {
    throw new Error('Google Drive is not connected. Setup → Settings → Google → Connect Google Drive');
  }
  if (!/^https:\/\//.test(baseUrl || '')) throw new Error("couldn't tell this app's https address for GitHub to call back");
  const ticket = signTicket({ t: tenantId, f: funnel.id, d: id, o: opts, n: String(name || '').slice(0, 200), s: sourceOf(source) }, await driveConnect.hookSecret(tenantId));
  const ref = c.githubRef || process.env.RAILWAY_GIT_BRANCH || 'main';
  const { url, init } = dispatchRequest({ repo: c.githubRepo || DEFAULT_REPO, token: c.githubToken, ref, hook: baseUrl, ticket });
  const res = await fetch(url, init);
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message || msg; } catch { /* keep the raw text */ }
    throw new Error(`GitHub refused to start the clean (${res.status}): ${msg || 'no reason given'}`);
  }
  const running = { state: 'running', runner: 'github', startedAt: Date.now(), lastAt: Date.now(), phase: 'queued', pct: 0, ...opts };
  cleanJobs.set(id, running);
  holdClean(id);
  log.info({ driveId: id, ref }, 'clean sent to GitHub Actions');
  return running;
}

/** A clean hook call whose ticket is missing, forged or expired. */
export class HookError extends Error {}

/** The ticket's payload, checked against its tenant's secret. */
async function hookTicket(ticket) {
  const peek = peekTicket(ticket);
  if (!peek || !peek.t || !peek.d) throw new HookError('bad ticket');
  const p = readTicket(ticket, await driveConnect.hookSecret(peek.t));
  if (!p || !p.d || !p.f) throw new HookError('ticket is invalid or expired');
  return p;
}

function hookPhase(driveId, patch) {
  const j = cleanJobs.get(driveId);
  const base = j && j.state === 'running' ? j : { state: 'running', runner: 'github', startedAt: Date.now(), phase: 'queued', pct: 0 };
  cleanJobs.set(driveId, { ...base, ...patch, lastAt: Date.now() });
}

const safeFileName = (s) => String(s || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N} ._-]+/gu, ' ').trim().slice(0, 120) || 'video';

/** What the workflow needs: where to download, the options, a Drive token and the app folder. */
export async function cleanHookJob({ ticket }) {
  const p = await hookTicket(ticket);
  const { token, folderId } = await driveConnect.drive(p.t);
  hookPhase(p.d, { phase: 'downloading', pct: 0 });
  const o = p.o || {};
  // The full timed SRT, the runner cuts it to the kept part once it knows the video's length.
  let srt = '';
  if (o.subs) {
    const { funnel } = await loadFunnel(p.f);
    srt = await videoSrt(funnel, p.d);
    if (!srt) throw new Error(NO_TIMED_SRT);
  }
  return {
    driveId: p.d,
    downloadUrl: publicDlUrl(p.d),
    zoomPct: o.zoomPct || 0,
    trimEndSec: o.trimEndSec || 0,
    endSec: o.endSec || 0,
    srt,
    accessToken: token,
    folderId,
    fileName: `${safeFileName(p.n || p.d)} (clean).mp4`,
  };
}

/** A fresh Drive token just before the upload (the first one may be close to expiring after a long encode). */
export async function cleanHookToken({ ticket }) {
  const p = await hookTicket(ticket);
  const { token, folderId } = await driveConnect.drive(p.t);
  return { accessToken: token, folderId };
}

/** The end card as a PNG at the video's own size. */
export async function cleanHookCard({ ticket, w, h }) {
  const p = await hookTicket(ticket);
  const o = p.o || {};
  return sharp(Buffer.from(endCardSvg({ w: Number(w) || 1080, h: Number(h) || 1920, text: o.endText, link: o.endLink }))).png().toBuffer();
}

export async function cleanHookProgress({ ticket, phase, pct, doneSec, totalSec }) {
  const p = await hookTicket(ticket);
  const ph = ['downloading', 'encoding', 'uploading'].includes(phase) ? phase : 'encoding';
  hookPhase(p.d, { phase: ph, pct: Math.max(0, Math.min(100, Math.round(Number(pct) || 0))), doneSec: Math.round(Number(doneSec) || 0), totalSec: Math.round(Number(totalSec) || 0) });
  return { ok: true };
}

/** The cleaned file is in the app's Drive folder: share it by link and keep it on the video's instance. */
export async function cleanHookDone({ ticket, fileId, durationSec }) {
  const p = await hookTicket(ticket);
  if (!/^[\w-]{10,}$/.test(String(fileId || ''))) throw new HookError('fileId required');
  const { client, folderId } = await driveConnect.drive(p.t);
  const meta = await client.fileMeta(fileId);
  if (folderId && Array.isArray(meta.parents) && !meta.parents.includes(folderId)) throw new HookError('file is not in the app folder');
  const { funnel } = await loadFunnel(p.f);
  if (String(funnel.tenant_id) !== String(p.t)) throw new HookError('ticket does not match the funnel');
  await client.makePublic(fileId);
  const clean = { url: publicDlUrl(fileId), driveFileId: String(fileId), runner: 'github', ...(p.o || {}), durationSec: Math.round(Number(durationSec) || 0), at: new Date().toISOString() };
  await saveClean(funnel, p.d, clean, { name: p.n || '', source: p.s || null });
  cleanJobs.set(p.d, { state: 'done', clean });
  releaseClean(p.d);
  log.info({ driveId: p.d, fileId }, 'video cleaned on GitHub Actions');
  return { ok: true };
}

export async function cleanHookFail({ ticket, error }) {
  const p = await hookTicket(ticket);
  const msg = String(error || 'the GitHub run failed').slice(0, 400);
  cleanJobs.set(p.d, { state: 'failed', error: `GitHub: ${msg}` });
  releaseClean(p.d);
  log.warn({ driveId: p.d, error: msg }, 'GitHub clean failed');
  return { ok: true };
}

/**
 * Once every channel has posted, the GitHub-cleaned copy is removed from your
 * Drive (the posts are live). Returns the steps with that noted.
 */
async function dropCleanedCopy(tenantId, steps) {
  const video = ((steps.find((x) => x.key === 'stitch') || {}).artifacts || {}).video || {};
  const c = video.clean;
  if (!c || !c.driveFileId || c.removedAt) return steps;
  try {
    const { client } = await driveConnect.drive(tenantId);
    await client.deleteFile(c.driveFileId);
    return patchStep(steps, 'stitch', { artifacts: { video: { ...video, clean: { ...c, removedAt: new Date().toISOString() } } } });
  } catch (err) {
    log.warn({ err: err.message, fileId: c.driveFileId }, 'could not remove the cleaned copy from Drive');
    return steps;
  }
}

/** Keep the cleaned video on the video's draft instance (made if there's none yet). */
async function saveClean(funnel, driveId, clean, { name = '', source = null } = {}) {
  const { inst, steps: base } = await ensureInstance({ funnel, driveId, name, title: 'Ready video (cleaned)', source });
  let steps = base;
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { ...videoArt(steps, driveId, clean.durationSec), clean } } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setMeta(inst.id, { durationSeconds: clean.durationSec || undefined });
  const job = cleanJobs.get(String(driveId));
  if (job && job.startedAt) await stepLog.span(inst.id, 'clean', new Date(job.startedAt).toISOString());
}

const AUTO_CHECK_SYSTEM = 'You check frames of a short video. Frame 1 is from the start, the others are its last seconds, in order. For each frame say: '
  + 'watermark: is there a small logo or brand mark laid over the picture (often in a bottom corner, e.g. "NotebookLM"); a title, slide text or subtitles are NOT a watermark. '
  + 'watermarkBottomPct: when that watermark is in the lower part of the picture, how far its TOP edge is above the bottom edge, as a percent of the picture height (e.g. 6); else 0. '
  + 'outro: is this frame a branded end screen (a product logo or "made with" card on a plain background) rather than the video’s own content. '
  + 'Return JSON: {"frames":[{"watermark":true|false,"watermarkBottomPct":number,"outro":true|false}, ...]}, one entry per image, in order.';

/**
 * Auto-check: an AI looks at an early frame and the last 15 s and sets this
 * video's zoom (watermark height) and cut (where the outro starts). Returns
 * { zoomPct, trimEndSec, note }; throws when the frames can't be read.
 */
async function autoCleanPlan({ funnel, providers, driveId, name, fallback }) {
  const total = (await videoDurations([driveId]))[driveId] || 0;
  if (!(total > 0)) throw new Error('could not read the video length');
  const { early, tail } = autoCheckTimes(total);
  const url = publicDlUrl(driveId);
  const ffmpeg = createFfmpegProvider({}, log);
  const frames = [];
  for (const atSec of [early, ...tail]) {
    const f = await ffmpeg.extractFrame({ url, atSec });
    frames.push(await sharp(f).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer());
  }
  const r = await providers.llm.generateJsonVision({ system: AUTO_CHECK_SYSTEM, user: `${frames.length} frames: the first at ${early} s, then one a second from ${tail[0]} s to ${tail[tail.length - 1]} s of a ${Math.round(total)} s video.`, images: frames });
  const cost = { ...costText({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, model: r.model }), provider: r.provider };
  await recordCost(funnel, driveId, 'stitch', cost, { name }).catch((err) => log.warn({ err: err.message, driveId }, 'auto-check cost not saved'));
  const got = autoCleanFromFrames({ frames: (r.data || {}).frames, tail, totalSec: total, fallback });
  log.info({ driveId, ...got }, 'clean auto-check');
  const what = [got.watermark ? `watermark found, zoom ${got.zoomPct}%` : 'no watermark', got.outro ? `outro found, cut last ${got.trimEndSec} s` : 'no outro'];
  return { zoomPct: got.zoomPct, trimEndSec: got.trimEndSec, note: `auto-check: ${what.join(', ')}` };
}

const ROUTER_CLEAN_WAIT_MS = 25 * 60 * 1000;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * The daily router's ✂ Clean for Lane 1, with the funnel's Clean defaults (or
 * the auto-check's numbers), waited for inside the router's run: on Railway it
 * runs here; on GitHub it is polled for up to 25 min. A video already cleaned
 * by hand keeps that clean. Never throws: { clean, note }, clean null = post
 * the original (Clean off, or it failed: note says why, for router_days and
 * the approval email).
 */
export async function cleanForRouter({ funnelId, driveId, name = '' }) {
  const id = String(driveId);
  let note = '';
  try {
    const { funnel, cfg } = await loadFunnel(funnelId);
    const o = routerCleanOpts(cfg);
    if (!o.on) return { clean: null, note: '' };
    const done = (await loadDrafts(funnel, [id]))[id];
    if (done && done.clean) return { clean: done.clean, note: 'cleaned earlier on the Prepare page' };
    const providers = await buildProviders(funnel.tenant_id);
    const opts = { zoomPct: o.zoomPct, trimEndSec: o.trimEndSec, ...normalizeEndCard(o) };
    if (o.auto) {
      try {
        const a = await autoCleanPlan({ funnel, providers, driveId: id, name, fallback: o });
        Object.assign(opts, normalizeCleanOpts(a));
        note = a.note;
      } catch (err) {
        log.warn({ err: err.message, driveId: id }, 'clean auto-check failed (funnel defaults used)');
        note = `auto-check failed (${String(err.message).slice(0, 120)}), used the funnel's zoom and cut`;
      }
    }
    if (!opts.zoomPct && !opts.trimEndSec && !opts.endSec) return { clean: null, note: [note, 'nothing to clean, the original video is used'].filter(Boolean).join('; ') };
    let job = cleanJobs.get(id);
    if (!job || job.state !== 'running') {
      const where = normalizeRunner((providers.resolved.clean || {}).runner);
      if (where === 'github') {
        job = await startCleanGithub({ funnel, providers, id, opts, name, source: null, baseUrl: settings.app.publicBaseUrl });
      } else {
        if (!providers.resolved.postformeKey) throw new Error('no Post for Me API key to upload the cleaned video');
        cleanJobs.set(id, { state: 'running', startedAt: Date.now(), phase: 'starting', pct: 0, ...opts });
        const onPhase = (patch) => { const j = cleanJobs.get(id); if (j && j.state === 'running') Object.assign(j, patch); };
        try {
          cleanJobs.set(id, { state: 'done', clean: await runClean({ funnel, providers, driveId: id, opts, name, source: null, onPhase }) });
        } catch (err) {
          cleanJobs.set(id, { state: 'failed', error: err.message });
          throw err;
        }
      }
    }
    // A GitHub run (or one already running): wait for its done / fail callback.
    const until = Date.now() + ROUTER_CLEAN_WAIT_MS;
    for (;;) {
      const j = cleanJobs.get(id) || { state: 'none' };
      if (j.state === 'done' && j.clean) {
        const c = j.clean;
        return { clean: c, note: [`cleaned: zoom ${c.zoomPct}%, cut last ${c.trimEndSec} s${c.endSec ? `, end card ${c.endSec} s` : ''}`, note].filter(Boolean).join('; ') };
      }
      if (j.state === 'failed') throw new Error(j.error || 'the clean failed');
      if (j.state !== 'running') throw new Error('the clean stopped without a result');
      if (Date.now() > until) throw new Error('still running on GitHub after 25 min (if it finishes before approval, posting uses the cleaned copy)');
      await sleep(15000);
    }
  } catch (err) {
    log.warn({ err: err.message, driveId: id }, 'router clean failed (original video used)');
    return { clean: null, note: [`clean failed, using the original video: ${String(err.message).slice(0, 200)}`, note].filter(Boolean).join('; ') };
  }
}

/** ✂ Clean one video and wait for it, wherever it runs. Throws when it fails. */
async function cleanAndWait({ funnelId, driveId, name = '', source = null, opts }) {
  const id = String(driveId);
  await startClean({ funnelId, driveId: id, ...opts, name, source, baseUrl: settings.app.publicBaseUrl });
  const until = Date.now() + ROUTER_CLEAN_WAIT_MS;
  for (;;) {
    const j = cleanJobs.get(id) || { state: 'none' };
    if (j.state === 'done' && j.clean) return j.clean;
    if (j.state === 'failed') throw new Error(j.error || 'the clean failed');
    if (j.state !== 'running') throw new Error('the clean stopped without a result');
    if (Date.now() > until) throw new Error('the clean is still running after 25 min');
    await sleep(5000);
  }
}

const FIX_MARGIN_MS = 5 * 60 * 1000;
const fixJobs = new Map();

/** One scheduled video: clean it, then swap the post at the same time. Returns { outcome, title, error? }. */
async function fixOne(row, opts) {
  const title = row.title || row.id;
  const steps = instanceService.parseSteps(row);
  const stepArt = (k) => (steps.find((x) => x.key === k) || {}).artifacts || {};
  const pub = stepArt('publish');
  const video = stepArt('stitch').video || {};
  const driveId = row.source_ref || video.driveId;
  const refs = (Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]')).filter(Boolean);
  const accountIds = (pub.channels || []).map((c) => c.id).filter(Boolean);
  if (!driveId || refs.length !== 1 || !accountIds.length) return { outcome: 'failed', title, error: 'not one plain scheduled post: use ✏ Edit, then Schedule' };
  const at = new Date(row.scheduled_for);
  if (at.getTime() - Date.now() < FIX_MARGIN_MS) return { outcome: 'failed', title, error: 'it goes out in under 5 minutes, left as it is' };

  const providers = await buildProviders(row.tenant_id);
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
  const req = pub.request && pub.request.mediaUrl ? pub.request : requestFromPost(await publish.getPost(refs[0]).catch(() => null));
  if (!req || !req.mediaUrl) return { outcome: 'failed', title, error: 'could not read the post from Post for Me' };
  const plan = cleanFixPlan({ mediaUrl: req.mediaUrl, clean: video.clean, opts });
  if (plan === 'already') return { outcome: 'already', title, zoomPct: video.clean.zoomPct, trimEndSec: video.clean.trimEndSec };

  // The cleaned copy comes first: until it exists the scheduled post is untouched.
  let clean = video.clean;
  if (plan === 'clean') {
    repairing.set(String(driveId), row.id);
    try {
      clean = await cleanAndWait({ funnelId: row.funnel_id, driveId, name: video.name || row.title || '', opts });
    } finally {
      repairing.delete(String(driveId));
    }
  }

  const now = await instanceRepo.get(row.id);
  const nowRefs = now ? (Array.isArray(now.post_refs) ? now.post_refs : JSON.parse(now.post_refs || '[]')) : [];
  if (!now || now.status !== 'scheduled' || nowRefs[0] !== refs[0]) return { outcome: 'failed', title, error: 'it changed while cleaning, left as it is' };
  if (at.getTime() - Date.now() < 2 * 60 * 1000) return { outcome: 'failed', title, error: 'its time came while cleaning, the original went out' };
  const old = await publish.getPost(refs[0]).catch(() => null);
  if (old && ['processing', 'processed'].includes(old.status)) return { outcome: 'failed', title, error: 'Post for Me is already publishing it' };

  // The new post first, then the old one goes: never none, never two.
  const request = swapMediaUrl(req, req.mediaUrl, clean.url);
  const made = await publish.createPost({ accountIds, scheduledAt: at.toISOString(), caption: request.caption, mediaUrl: request.mediaUrl, platformConfigurations: request.platformConfigurations });
  const ref = made && made.id;
  if (!ref) throw new Error('Post for Me did not return a post id');
  try {
    await publish.deletePost(refs[0]);
  } catch (err) {
    await publish.deletePost(ref).catch((e) => log.error({ err: e.message, instance: row.id, ref }, 'replacement post could not be removed'));
    throw new Error(`could not replace the old post, it stays as it was: ${err.message}`);
  }
  const latest = patchStep(instanceService.parseSteps(now), 'publish', { artifacts: { posts: [ref], request } });
  await instanceRepo.saveSteps(row.id, latest, sumInstanceCost(latest));
  await instanceRepo.markScheduled(row.id, { postRefs: [ref], scheduledFor: at });
  await firstCommentsRepo.moveToPost(refs[0], ref).catch((err) => log.warn({ err: err.message, instance: row.id }, 'first comment job not moved'));
  await captureRules.movePost(refs[0], ref).catch((err) => log.warn({ err: err.message, instance: row.id }, 'comment-to-DM rule not moved'));
  log.info({ instance: row.id, from: refs[0], to: ref }, 'scheduled post now uses the cleaned video');
  return { outcome: 'fixed', title, zoomPct: clean.zoomPct, trimEndSec: clean.trimEndSec, durationSec: clean.durationSec };
}

/**
 * ✂ Fix scheduled videos: every scheduled ready video still posting its original
 * gets these numbers and a replacement post at the same time. One at a time, in
 * the background; the Library polls fixStatus.
 */
export async function startFixScheduled({ tenantId = 'default', options }) {
  const running = fixJobs.get(tenantId);
  if (running && running.state === 'running') return running;
  const opts = normalizeScheduleClean(options);
  if (!opts) throw new Error('give a zoom or a cut first');
  const rows = await instanceRepo.scheduledReadyVideos(tenantId);
  const job = { state: 'running', total: rows.length, done: 0, results: [] };
  fixJobs.set(tenantId, job);
  heartbeat.during('clean', async () => {
    for (const row of rows) {
      const out = await fixOne(row, opts).catch((err) => {
        log.error({ err: err.message, instance: row.id }, 'scheduled video fix failed');
        return { outcome: 'failed', title: row.title || row.id, error: err.message };
      });
      job.results.push(out);
      job.done += 1;
    }
  }).then(() => { job.state = 'done'; }).catch((err) => { job.state = 'failed'; job.error = err.message; });
  return job;
}

export function fixStatus({ tenantId = 'default' } = {}) {
  return fixJobs.get(tenantId) || { state: 'none' };
}

/** Where a clean job stands (running / done / failed), else the saved cleaned video. */
export async function cleanStatus({ funnelId, driveId }) {
  const job = cleanJobs.get(String(driveId));
  // A GitHub run that has gone quiet for 40 min isn't coming back.
  if (job && job.state === 'running' && job.runner === 'github' && Date.now() - (job.lastAt || job.startedAt) > 40 * 60 * 1000) {
    const failed = { state: 'failed', error: 'GitHub went quiet for 40 min, check the Actions tab, then press ✂ Clean again' };
    cleanJobs.set(String(driveId), failed);
    return failed;
  }
  if (job) return job;
  const { funnel } = await loadFunnel(funnelId);
  const d = (await loadDrafts(funnel, [String(driveId)]))[String(driveId)];
  return d && d.clean ? { state: 'done', clean: d.clean } : { state: 'none' };
}

/**
 * Keep every generation: one "draft" instance per video, its latest copy,
 * transcript and thumbnails as JSON on the steps (all generations kept in
 * script.artifacts.generations), and every generation's real cost added.
 */
async function saveDraft({ funnel, driveId, copy, thumbs, sizes, thumbError, costs, edit = false, ctaLink, keepThumbs = false }) {
  const { inst, steps: base, existing } = await ensureInstance({ funnel, driveId, title: copy.title || 'Ready video' });
  let steps = base;
  const at = new Date().toISOString();
  const prev = ((steps.find((x) => x.key === 'script') || {}).artifacts || {}).generations || [];
  // A manual save (edits) updates the current copy; only a real generation is
  // added to the history.
  const generations = edit ? prev : [...prev, { at, copy, thumbs, sizes, thumbError }].slice(-20);
  // The transcript belongs to its own stage (transcribe / approve): never touched here.
  steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: copy.description, copy, generations, ...(ctaLink !== undefined ? { ctaLink } : {}) } });
  if (!keepThumbs && (sizes.length || !edit)) steps = patchStep(steps, 'images', { status: sizes.length ? 'done' : 'skipped', artifacts: { thumbs, sizes } });
  const durationSec = durationCache.get(driveId) || 0;
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: videoArt(steps, driveId, durationSec) } });
  // An edit save carries a generation's cost only the first time (no draft yet).
  for (const c of edit && existing ? [] : costs || []) {
    const { step, ...entry } = c;
    steps = addCostToSteps(steps, ['transcript', 'images'].includes(step) ? step : 'script', { ...entry, costUsd: Number(entry.costUsd) || 0, at });
  }
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setMeta(inst.id, { title: copy.title || undefined, durationSeconds: durationSec || undefined });
  return inst.id;
}

/**
 * 💾 Save draft: keep what's on the page for one video (edited copy,
 * thumbnails) without regenerating. The transcript is saved by its own stage. Thumbnails sent only as
 * platform -> url are grouped back into their sizes.
 */
export async function saveDraftEdit({ funnelId, driveId, copy, thumbs = {}, sizes = [], costs = [], ctaLink = '' }) {
  if (!driveId) throw new Error('driveId required');
  const { funnel } = await loadFunnel(funnelId);
  const clean = normalizeCopy(copy);
  if (!clean.title && !clean.description) throw new Error('nothing to save: generate or write the copy first');
  const urls = Object.fromEntries(Object.entries(thumbs && typeof thumbs === 'object' ? thumbs : {})
    .filter(([k, v]) => PLATFORM_SIZE[k] && /^https:\/\/\S+$/.test(String(v))));
  let grouped = (Array.isArray(sizes) ? sizes : []).filter((z) => z && THUMB_SIZES[z.size] && /^https:\/\/\S+$/.test(String(z.url)));
  if (!grouped.length) {
    for (const [size, spec] of Object.entries(THUMB_SIZES)) {
      const users = Object.keys(urls).filter((k) => PLATFORM_SIZE[k] === size);
      if (users.length) grouped.push({ size, label: spec.label, url: urls[users[0]], platforms: users });
    }
  }
  grouped = grouped.map((z) => ({ size: z.size, label: THUMB_SIZES[z.size].label, url: String(z.url), platforms: (z.platforms || []).filter((k) => PLATFORM_SIZE[k]) }));
  const okCosts = (Array.isArray(costs) ? costs : []).filter((c) => c && Number.isFinite(Number(c.costUsd))).slice(0, 8);
  const cta = /^https?:\/\/\S+$/.test(String(ctaLink || '').trim()) ? String(ctaLink).trim() : '';
  const instanceId = await saveDraft({ funnel, driveId: String(driveId), ctaLink: cta, copy: clean, thumbs: urls, sizes: grouped, thumbError: '', costs: okCosts, edit: true });
  return { instanceId };
}

/** The saved AI drafts for these videos, for the page to restore: { driveId: draft }. */
async function loadDrafts(funnel, driveIds) {
  const rows = await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, driveIds).catch(() => ({}));
  const out = {};
  for (const [driveId, row] of Object.entries(rows)) {
    const d = draftView(row);
    if (d) out[driveId] = d;
  }
  return out;
}

/** What the stage panels need from one instance (null when it holds nothing yet). */
function draftView(row) {
  const steps = instanceService.parseSteps(row);
  const step = (k) => steps.find((x) => x.key === k) || {};
  const art = (k) => step(k).artifacts || {};
  const costUsd = steps.reduce((t, x) => t + (x.costs || []).reduce((u, c) => u + (Number(c.costUsd) || 0), 0), 0);
  const clean = (art('stitch').video || {}).clean || null;
  const hasTranscript = step('transcript').status === 'done';
  const t = art('transcript');
  if (!art('script').copy && !clean && !hasTranscript && !t.comparison) return null;
  return {
    instanceId: row.id, stage: readyStage(row, steps), clean, copy: art('script').copy || null, ctaLink: art('script').ctaLink || '',
    comparison: t.comparison || '', noSpeech: isNoSpeech(steps), transcript: t.text || '', headline: t.headline || '', subhead: t.subhead || '', imagePrompt: t.imagePrompt || '', hasTranscript, srt: !!t.srt, timed: !!transcriptSrt(t), approved: !!t.approvedAt, approvedIst: t.approvedAt ? formatIst(t.approvedAt) : '',
    thumbs: art('images').thumbs || {}, sizes: art('images').sizes || [], costUsd, atIst: formatIst(row.updated_at),
  };
}

/** Record one direct post as a posted instance (stages skipped; AI-copy cost if any). */
async function recordPostedInstance({ funnel, driveId, caption, scheduledIso, ref, copy = null, costs = [], durationSec = 0, channels = [], request = null, ctaLink = '' }) {
  const publishArt = { posts: ref ? [ref] : [], caption, channels, ...(request ? { request } : {}) };
  const sched = { postRefs: ref ? [ref] : [], scheduledFor: scheduledIso ? new Date(scheduledIso) : null, postNow: !scheduledIso };
  const draft = copy ? (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [driveId]).catch(() => ({})))[driveId] : null;
  if (draft) {
    // The generation (and its cost) is already on the draft, finish it.
    let steps = instanceService.parseSteps(draft);
    steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: copy.description, copy, ctaLink } });
    steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: videoArt(steps, driveId, durationSec) } });
    steps = patchStep(steps, 'publish', { status: 'done', artifacts: publishArt });
    await instanceRepo.saveSteps(draft.id, steps, sumInstanceCost(steps));
    await instanceRepo.setMeta(draft.id, {
      title: `${copy.title || 'Ready video'} · ${scheduledIso ? formatIst(scheduledIso, { withTime: false }) : 'now'}`,
      durationSeconds: durationSec || undefined,
      scheduledFor: scheduledIso ? new Date(scheduledIso) : undefined,
    });
    // Scheduled (still editable) until Post for Me reports it published, see refreshScheduled.
    await instanceRepo.markScheduled(draft.id, sched);
    return draft.id;
  }
  const inst = await instanceService.createForFunnel({
    tenantId: funnel.tenant_id,
    funnel,
    title: `${copy && copy.title ? copy.title : 'Ready video'} · ${scheduledIso ? formatIst(scheduledIso, { withTime: false }) : 'now'}`,
    scheduledFor: scheduledIso ? new Date(scheduledIso) : null,
    sourceType: 'drive_folder',
    sourceRef: driveId,
  });
  let steps = buildInitialSteps();
  for (const k of ['script', 'images', 'animate', 'voiceover', 'transcript']) steps = patchStep(steps, k, { status: 'skipped' });
  if ((costs || []).some((c) => c && c.step === 'images')) steps = patchStep(steps, 'images', { status: 'done' });
  if (copy) {
    steps = patchStep(steps, 'transcript', { status: 'done' });
    steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: copy.description, copy } });
  }
  for (const c of costs || []) {
    const { step, ...entry } = c;
    steps = addCostToSteps(steps, ['transcript', 'images'].includes(step) ? step : 'script', { ...entry, costUsd: Number(entry.costUsd) || 0, at: new Date().toISOString() });
  }
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: videoArt(steps, driveId, durationSec) } });
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: publishArt });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  if (durationSec) await instanceRepo.setMeta(inst.id, { durationSeconds: durationSec });
  await instanceRepo.markScheduled(inst.id, sched);
  return inst.id;
}

/**
 * Post the tick-selected videos, in selection order, each at its own schedule
 * (explicit "DD-MM-YYYY HH:MM" IST, else the next sequential daily slot). Sends a
 * posted-summary email. Returns a per-item result list.
 */
export async function postSelections({ tenantId = 'default', funnelId, selections, accessToken = '', accounts: pickedAccounts = null }) {
  const { funnel, resolved, cfg } = await loadFunnel(funnelId, pickedAccounts);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const drive = driveFor(providers, accessToken);
  const clean = normalizeSelections(selections);
  if (!clean.length) throw new Error('no videos selected');

  // The Post for Me key is central (API Keys page); the funnel picks the accounts.
  const postformeKey = providers.resolved.postformeKey || '';
  if (!postformeKey) throw new Error('No Post for Me API key, set it once under Setup → Keys and credit');
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  if (!accounts.length) throw new Error('No accounts ticked: tick the accounts to post to (top of this page)');
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);

  // YouTube needs a title. When any selected account is a YouTube one and the
  // funnel has a direct_yt_title, pass it as a per-platform configuration (the
  // caption serves as the YouTube description; IG/LinkedIn use the caption too).
  const accountMap = resolved.accountMap || {};
  const hasYoutube = accounts.some((id) => String((accountMap[id] || {}).platform || '').toLowerCase().includes('youtube'));
  const ytTitle = String((cfg && cfg.direct_yt_title) || '').trim();
  const platformConfigurations = hasYoutube && ytTitle ? { youtube: { title: ytTitle } } : undefined;

  const slots = defaultSlotsIso(resolved.publishTime, clean.length);
  // A video cleaned with ✂ Clean posts its cleaned copy instead of the Drive original.
  const saved = await loadDrafts(funnel, clean.map((x) => x.driveId));
  const results = [];
  for (let i = 0; i < clean.length; i += 1) {
    const sel = clean[i];
    // "Post now" => no scheduled_at, so Post-for-Me publishes immediately.
    const scheduledIso = postTimeIso(sel, slots[i]);
    // AI-copy lane: each platform gets its own copy for this video.
    const cleaned = (saved[sel.driveId] || {}).clean || null;
    const videoUrl = cleaned ? cleaned.url : publicDlUrl(sel.driveId);
    // CTA: this post's own link overrides the funnel's.
    const ai = sel.copy ? platformConfigsFor(sel.copy, { accountIds: accounts, accountMap, ctaLink: sel.ctaLink || resolved.ctaLink, videoUrl, thumbs: sel.thumbs }) : null;
    const caption = ai ? ai.caption : (sel.caption.trim() || captionFor(cfg, resolved));
    try {
      await drive.shareAnyone(sel.driveId);
      // Kept on the instance so failed channels can be re-posted exactly.
      const request = { caption, mediaUrl: videoUrl, platformConfigurations: ai ? ai.platformConfigurations : platformConfigurations };
      const result = await publish.createPost({ accountIds: accounts, scheduledAt: scheduledIso || undefined, ...request });
      const ref = result && result.id ? result.id : null;
      // The link goes in each channel's first comment once the post is live.
      await firstComment.queue({ tenantId: funnel.tenant_id, postformePostId: ref, link: sel.ctaLink || resolved.ctaLink, scheduledAt: scheduledIso });
      // Arm comment-to-DM for this post (funnel-level keyword/dm defaults).
      if (ref && resolved.captureKeyword) {
        await captureRules.createForPublish({
          tenantId: funnel.tenant_id, funnelId: funnel.id, lane: funnel.name,
          platforms: captureRules.dmPlatforms(accounts, accountMap),
          postformePostId: ref,
          keyword: resolved.captureKeyword, dmText: resolved.captureDmText, dmLink: sel.ctaLink || resolved.captureDmLink || resolved.ctaLink,
          publicReplyVariants: resolved.capturePublicReplies,
          requireFollow: resolved.captureRequireFollow, followupText: resolved.captureFollowupText,
          notFollowingText: resolved.captureNotFollowingText, log,
        }).catch((err) => log.warn({ err: err.message }, 'capture rule create failed (posted anyway)'));
      }
      const instanceId = await recordPostedInstance({
        funnel, driveId: sel.driveId, caption, scheduledIso, ref,
        copy: sel.copy ? normalizeCopy(sel.copy) : null, costs: sel.costs, request, ctaLink: sel.ctaLink,
        channels: accounts.map((id) => ({ id, platform: (accountMap[id] || {}).platform || '', name: (accountMap[id] || {}).account_name || id, state: 'waiting' })),
        durationSec: (cleaned && cleaned.durationSec) || (await videoDurations([sel.driveId]))[sel.driveId] || 0,
      });
      try {
        await drive.renameFile(sel.driveId, `POSTED - ${sel.name || sel.driveId}`);
      } catch (err) {
        log.warn({ err: err.message, driveId: sel.driveId }, 'POSTED tag failed (posted anyway)');
      }
      results.push({ driveId: sel.driveId, name: sel.name, scheduledIso, whenIst: scheduledIso ? formatIst(scheduledIso) : '', caption, ref, instanceId, ok: true });
      log.info({ funnel: funnel.name, driveId: sel.driveId, scheduledIso, ref }, 'ready video posted');
    } catch (err) {
      log.error({ err: err.message, driveId: sel.driveId }, 'ready video post failed');
      results.push({ driveId: sel.driveId, name: sel.name, ok: false, error: err.message });
    }
  }

  return { funnel: funnel.name, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// 📅 Schedule / ⚡ Post now jobs by Drive id: { state: running | done | failed, instanceId, error? }.
// The outcome is saved on the instance too (scheduled, or post_failed with the reason), so a
// restart only loses this map; the Library reads a post that went quiet as not finished.
const postJobs = new Map();

/**
 * 📅 / ⚡ pressed: check what can fail at once (key, accounts), mark each video's
 * instance as posting (with its IST time), then hand the posts to Post for Me in
 * the background so the page can leave straight away. Returns one item a video.
 */
/** The IST post date (yyyy-MM-dd) of a schedule time, or today for Post now. */
const postDateOf = (iso) => (iso ? DateTime.fromISO(iso) : DateTime.now()).setZone('Asia/Kolkata').toFormat('yyyy-MM-dd');

/**
 * Thrown by startPost when a hand-scheduled video lands on a day the router
 * already filled for this funnel; the page asks: replace it, or post both.
 */
export class RouterClash extends Error {
  constructor(clashes) {
    super('the router already lined up a post for that day');
    this.clashes = clashes;
  }
}

/**
 * The router's picks that clash with these items (see routerClash), each with
 * the held instance and its router_days row, for the page to show.
 */
async function routerClashes(funnel, items) {
  const out = [];
  for (const item of items) {
    const postDate = postDateOf(item.scheduledIso);
    const day = await routerDays.get(funnel.id, postDate).catch(() => null);
    const held = day && day.instance_id ? await instanceRepo.get(day.instance_id).catch(() => null) : null;
    const c = routerClash(day, held, { instanceId: item.instanceId, driveId: item.driveId });
    if (c) out.push({ ...c, driveId: item.driveId, name: item.name, postDate, day: formatIst(DateTime.fromISO(postDate, { zone: 'Asia/Kolkata' }), { withTime: false }), held: { id: held.id, title: held.title || '', status: held.status }, dayId: day.id });
  }
  return out;
}

/** Replace the router's pick: release (ready video) or supersede it, and point the day at this post. */
async function replaceRouterPick(clash, instanceId) {
  const held = await instanceRepo.get(clash.held.id);
  const action = rerunAction(held);
  if (action === 'keep') throw new Error(`${clash.held.title || 'the router post'} for ${clash.day} is already scheduled with Post for Me, so it can't be replaced here`);
  if (action === 'supersede') await instanceRepo.supersede(held.id, 'replaced by a hand-scheduled post');
  if (action === 'release') await instanceRepo.releaseSlot(held.id);
  await routerDays.update(clash.dayId, { lane: 'ready_video', reason: 'replaced by a hand-scheduled post', instanceId });
}

export async function startPost({ tenantId = 'default', funnelId, selections, accessToken = '', accounts: pickedAccounts = null, onClash = '' }) {
  const { funnel, resolved } = await loadFunnel(funnelId, pickedAccounts);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const clean = normalizeSelections(selections);
  if (!clean.length) throw new Error('no videos selected');
  if (!providers.resolved.postformeKey) throw new Error('No Post for Me API key, set it once under Setup → Keys and credit');
  if (!(Array.isArray(resolved.accounts) && resolved.accounts.length)) throw new Error('No accounts ticked: tick the accounts to post to (top of this page)');
  const busy = clean.filter((s) => (postJobs.get(s.driveId) || {}).state === 'running');
  if (busy.length) throw new Error(`Already posting ${busy.map((s) => s.name || s.driveId).join(', ')}, wait for it to finish`);

  const slots = defaultSlotsIso(resolved.publishTime, clean.length);
  const items = [];
  for (let i = 0; i < clean.length; i += 1) {
    const sel = clean[i];
    const scheduledIso = postTimeIso(sel, slots[i]);
    const { inst } = await ensureInstance({ funnel, driveId: sel.driveId, name: sel.name });
    items.push({ driveId: sel.driveId, name: sel.name, instanceId: inst.id, scheduledIso, whenIst: scheduledIso ? formatIst(scheduledIso) : '' });
  }
  // A day the router already filled: ask first ('replace' or 'both').
  const clashes = await routerClashes(funnel, items);
  if (clashes.length && onClash !== 'replace' && onClash !== 'both') throw new RouterClash(clashes);
  if (onClash === 'replace') {
    for (const c of clashes) await replaceRouterPick(c, items.find((x) => x.driveId === c.driveId).instanceId);
  }
  for (const item of items) {
    await instanceRepo.markPosting(item.instanceId, { scheduledFor: item.scheduledIso ? new Date(item.scheduledIso) : null });
    await stepLog.start(item.instanceId, 'publish');
    postJobs.set(item.driveId, { state: 'running', instanceId: item.instanceId, scheduledIso: item.scheduledIso, startedAt: Date.now() });
  }

  const fail = async (item, why) => {
    postJobs.set(item.driveId, { state: 'failed', instanceId: item.instanceId, error: why });
    await stepLog.fail(item.instanceId, 'publish');
    await instanceRepo.markPostFailed(item.instanceId, why).catch((err) => log.warn({ err: err.message, instance: item.instanceId }, 'could not save the post failure'));
  };
  // The Clean panel's numbers apply here when ✂ Clean was not pressed. A failed clean posts nothing.
  const cleanThenPost = async () => {
    const ready = [];
    const refused = [];
    for (const sel of clean) {
      try {
        const saved = sel.cleanOpts ? (await loadDrafts(funnel, [sel.driveId]))[sel.driveId] : null;
        if (sel.cleanOpts && !(saved && saved.clean)) await cleanAndWait({ funnelId, driveId: sel.driveId, name: sel.name, opts: sel.cleanOpts });
        ready.push(sel);
      } catch (err) {
        refused.push({ driveId: sel.driveId, name: sel.name, ok: false, error: `✂ Clean failed, nothing posted: ${err.message}` });
      }
    }
    const out = ready.length ? await postSelections({ tenantId, funnelId, selections: ready, accessToken, accounts: pickedAccounts }) : { results: [] };
    return { ...out, results: [...(out.results || []), ...refused] };
  };
  heartbeat.during('post', cleanThenPost)
    .then(async (out) => {
      for (const item of items) {
        const r = (out.results || []).find((x) => x.driveId === item.driveId);
        if (r && r.ok) {
          postJobs.set(item.driveId, { state: 'done', instanceId: r.instanceId || item.instanceId, scheduledIso: r.scheduledIso });
          await stepLog.end(item.instanceId, 'publish');
        } else await fail(item, (r && r.error) || 'not posted');
      }
    })
    .catch(async (err) => {
      const why = (err && err.message) || String(err) || 'unknown error';
      log.error({ err: why, funnel: funnel.name }, 'background post failed');
      for (const item of items) await fail(item, why);
    });
  return { funnel: funnel.name, items };
}

/** Where a Schedule / Post now job stands ('none' when there is none in memory). */
export function postStatus({ driveId }) {
  return postJobs.get(String(driveId)) || { state: 'none' };
}

/**
 * Scheduled → posted only when Post for Me says so. For each scheduled
 * instance whose time has come: read every post it made, mark each channel
 * ✅ / ❌ from Post for Me's per-account results, then posted (locked, all ✅),
 * partly posted (some ✅: open for a retry of the rest) or failed (none ✅),
 * and email the outcome. Runs on a 5-minute timer, on /jobs/run-due, and when
 * the instances list or an instance opens. Returns how many changed.
 */
/**
 * Callbacks run when the post check finds an instance live ('posted' or
 * 'partial'): fn(row, { outcome, refs, channels }). The image lane uses this to
 * write Posted + the Post for Me id into its sheet row. Errors are logged only.
 */
const postedHooks = [];
export function onPosted(fn) {
  if (typeof fn === 'function') postedHooks.push(fn);
}

export async function refreshScheduled({ tenantId = 'default' } = {}) {
  const rows = await instanceRepo.scheduledDue(tenantId).catch(() => []);
  if (!rows.length) return 0;
  const providers = await buildProviders(tenantId);
  if (!providers.resolved.postformeKey) return 0;
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log);
  // The webhook is what wakes a sleeping app when a post goes live.
  await firstComment.ensureWebhook(tenantId, publish).catch(() => false);
  let changed = 0;
  for (const row of rows) {
    try {
      const refs = (Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]')).filter(Boolean);
      if (!refs.length) continue;
      let steps = instanceService.parseSteps(row);
      const pub = ((steps.find((x) => x.key === 'publish') || {}).artifacts) || {};
      const results = {};
      let pending = false;
      let postedAt = null;
      for (const ref of refs) {
        const post = await publish.getPost(ref);
        if (postOutcome(post) === 'pending') { pending = true; continue; }
        if (post.updated_at && (!postedAt || new Date(post.updated_at) > postedAt)) postedAt = new Date(post.updated_at);
        for (const r of await publish.postResults(ref)) {
          const prev = results[r.social_account_id];
          if (prev && prev.success) continue;
          results[r.social_account_id] = {
            success: !!r.success,
            error: r.error ? (r.error.message || JSON.stringify(r.error)) : '',
            url: (r.platform_data && (r.platform_data.url || r.platform_data.permalink)) || '',
          };
        }
      }
      if (pending) continue;
      // Older instances have no channel list: build it from the results.
      const base = Array.isArray(pub.channels) && pub.channels.length
        ? pub.channels
        : Object.keys(results).map((id) => ({ id, platform: '', name: id, state: 'waiting' }));
      const channels = mergeChannels(base, results);
      const outcome = channelOutcome(channels);
      if (outcome === 'pending') continue;
      // A recoverable failure (e.g. a token Meta revoked) is retried on its own
      // once you reconnect the account; you get one email, not one per try.
      const retry = pub.retry || { attempts: 0 };
      const nextAt = outcome === 'posted' ? null : nextAutoRetry(channels, retry.attempts);
      steps = patchStep(steps, 'publish', { artifacts: { channels, retry: { ...retry, nextAt } } });
      if (outcome === 'posted') steps = await dropCleanedCopy(tenantId, steps);
      await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
      const when = postedAt || new Date();
      const failedNote = channels.filter((c) => c.state === 'failed').map((c) => channelText(c)).join('; ');
      if (outcome === 'posted') await instanceRepo.lockAsPosted(row.id, { postRefs: refs, postedAt: when });
      else if (outcome === 'partial') await instanceRepo.markPartial(row.id, { note: failedNote, postedAt: when });
      else {
        await instanceRepo.setStatus(row.id, 'failed', failedNote || 'Post for Me reported a failure');
        await instanceRepo.setPostStatus(row.id, 'failed');
      }
      if (outcome === 'posted' || outcome === 'partial') {
        for (const fn of postedHooks) {
          await Promise.resolve(fn(row, { outcome, refs, channels })).catch((err) => log.warn({ err: err.message, instance: row.id }, 'post-live hook failed'));
        }
      }
      changed += 1;
    } catch (err) {
      log.warn({ err: err.message, instance: row.id }, 'scheduled post check failed (will retry)');
    }
  }
  return changed;
}

/**
 * refreshScheduled for every tenant (the Post for Me webhook, the wake-up
 * crons, boot). One run at a time: a channel's webhook arriving mid-run asks
 * for one more pass instead of a parallel one, so no channel is marked twice.
 */
let refreshing = null;
let refreshAgain = false;
export function refreshAllTenants() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = heartbeat.during('post-check', async () => {
    let n = 0;
    do {
      refreshAgain = false;
      n += await refreshAllTenantsOnce();
    } while (refreshAgain);
    return n;
  }).finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Ask Post for Me again for live links we don't have (posted before they were
 * shown, or not ready at the first check). Each channel gets 3 tries, so one
 * that never gives a link stops costing calls.
 */
async function fillMissingLinks({ tenantId = 'default' } = {}) {
  const rows = await instanceRepo.missingLinks(tenantId);
  if (!rows.length) return;
  const providers = await buildProviders(tenantId);
  if (!providers.resolved.postformeKey) return;
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log);
  for (const row of rows) {
    try {
      const refs = (Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]')).filter(Boolean);
      const urls = {};
      for (const ref of refs) {
        for (const r of await publish.postResults(ref)) {
          const url = r.success && r.platform_data && (r.platform_data.url || r.platform_data.permalink);
          if (url) urls[r.social_account_id] = url;
        }
      }
      const steps = instanceService.parseSteps(row);
      const pub = ((steps.find((x) => x.key === 'publish') || {}).artifacts) || {};
      const channels = (pub.channels || []).map((c) => {
        if (c.state !== 'ok' || c.url) return c;
        return urls[c.id] ? { ...c, url: urls[c.id] } : { ...c, linkTries: (Number(c.linkTries) || 0) + 1 };
      });
      await instanceRepo.saveLinks(row.id, patchStep(steps, 'publish', { artifacts: { channels } }));
    } catch (err) {
      log.warn({ err: err.message, instance: row.id }, 'post link fill failed (will retry)');
    }
  }
}

async function refreshAllTenantsOnce() {
  const list = await tenantRepo.list().catch(() => [{ id: 'default' }]);
  let n = 0;
  for (const t of list) {
    n += await refreshScheduled({ tenantId: t.id }).catch(() => 0);
    n += await autoRetryDue({ tenantId: t.id }).catch(() => 0);
    await fillMissingLinks({ tenantId: t.id }).catch((err) => log.warn({ err: err.message }, 'post link fill failed'));
    await firstComment.runDue({ tenantId: t.id }).catch((err) => log.warn({ err: err.message }, 'first comment run failed'));
    await digest.runDue({ tenantId: t.id }).catch((err) => log.warn({ err: err.message }, 'daily email failed (the next check tries again)'));
  }
  return n;
}

/**
 * ↻ Post to the failed channels only: the same post (caption, video,
 * per-platform copy and thumbnails), sent again to just the ❌ accounts:
 * after you reconnect them in Post for Me. The ✅ ones are not posted twice.
 */
export async function retryFailed({ instanceId, auto = false }) {
  const row = await instanceRepo.get(instanceId);
  if (!row) throw new Error('instance not found');
  if (!['partial', 'failed'].includes(row.status)) throw new Error('nothing failed on this instance');
  let steps = instanceService.parseSteps(row);
  const pub = ((steps.find((x) => x.key === 'publish') || {}).artifacts) || {};
  const failed = (pub.channels || []).filter((c) => c.state === 'failed');
  if (!failed.length) throw new Error('no failed channels to retry');
  const providers = await buildProviders(row.tenant_id);
  const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
  const oldRefs = Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]');
  // Posts made before requests were saved: read the original back from Post for Me.
  let req = pub.request && pub.request.mediaUrl ? pub.request : null;
  if (!req && oldRefs[0]) req = requestFromPost(await publish.getPost(oldRefs[0]).catch(() => null));
  if (!req) throw new Error('could not read the original post from Post for Me, use ✏ Edit and post it again');
  const platforms = new Set(failed.map((c) => platformKey(c.platform)).filter(Boolean));
  const configs = req.platformConfigurations
    ? Object.fromEntries(Object.entries(req.platformConfigurations).filter(([k]) => !platforms.size || platforms.has(k)))
    : undefined;
  const result = await publish.createPost({ accountIds: failed.map((c) => c.id), caption: req.caption, mediaUrl: req.mediaUrl, platformConfigurations: configs });
  const ref = result && result.id ? result.id : null;
  if (!ref) throw new Error('Post for Me did not return a post id');
  // The re-posted channels get the same first comment as the original post.
  const original = oldRefs[0] ? await firstCommentsRepo.getByPost(oldRefs[0]).catch(() => null) : null;
  if (original) await firstComment.queue({ tenantId: row.tenant_id, postformePostId: ref, link: original.text });
  const refs = [...oldRefs, ref];
  const channels = (pub.channels || []).map((c) => (c.state === 'failed' ? { ...c, state: 'waiting', error: '' } : c));
  // A press of the button starts the automatic tries afresh; an automatic try counts one.
  const attempts = auto ? ((pub.retry && pub.retry.attempts) || 0) + 1 : 0;
  steps = patchStep(steps, 'publish', { artifacts: { channels, posts: refs, request: req, retry: { attempts, nextAt: null, lastAt: new Date().toISOString() } } });
  await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
  await instanceRepo.markScheduled(row.id, { postRefs: refs });
  log.info({ instance: row.id, retried: failed.length, ref, auto, attempts }, 'failed channels re-posted');
  return { instanceId: row.id, retried: failed.length };
}

/**
 * The automatic tries: every partly posted / failed instance whose next try is
 * due is re-posted to its ❌ channels. A try that cannot even be sent (Post for
 * Me down, say) still counts, so it never loops forever.
 */
export async function autoRetryDue({ tenantId = 'default' } = {}) {
  const rows = await instanceRepo.retryDue(tenantId).catch(() => []);
  let n = 0;
  for (const row of rows) {
    try {
      await retryFailed({ instanceId: row.id, auto: true });
      n += 1;
    } catch (err) {
      log.warn({ err: err.message, instance: row.id }, 'automatic retry failed');
      let steps = instanceService.parseSteps(row);
      const pub = ((steps.find((x) => x.key === 'publish') || {}).artifacts) || {};
      const attempts = ((pub.retry && pub.retry.attempts) || 0) + 1;
      steps = patchStep(steps, 'publish', { artifacts: { retry: { attempts, nextAt: nextAutoRetry(pub.channels, attempts), lastError: err.message } } });
      await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps)).catch(() => {});
    }
  }
  return n;
}

/**
 * ✏ Edit a scheduled post: delete it on Post for Me first (so nothing goes out
 * while you correct it), then the instance is a draft again. Schedule or Post
 * now creates a fresh post. Refused once Post for Me has started publishing.
 */
export async function unscheduleInstance({ instanceId }) {
  const row = await instanceRepo.get(instanceId);
  if (!row) throw new Error('instance not found');
  if (row.locked) throw new Error('already posted: it can no longer be edited');
  if (!['scheduled', 'failed'].includes(row.status)) throw new Error('this instance is not scheduled');
  const refs = (Array.isArray(row.post_refs) ? row.post_refs : JSON.parse(row.post_refs || '[]')).filter(Boolean);
  if (row.status === 'scheduled' && refs.length) {
    const providers = await buildProviders(row.tenant_id);
    const publish = createPostForMeProvider({ apiKey: providers.resolved.postformeKey || '' }, log);
    for (const ref of refs) {
      const post = await publish.getPost(ref).catch(() => null);
      if (post && ['processing', 'processed'].includes(post.status)) throw new Error('Post for Me is already publishing this post, it can no longer be edited');
      await publish.deletePost(ref);
    }
  }
  await instanceRepo.unschedule(row.id);
  log.info({ instance: row.id, deleted: refs.length }, 'scheduled post paused for editing');
  return { instanceId: row.id };
}

// ---- daily router Lane 1 helpers -------------------------------------------

/**
 * Every file in the funnel's ready-video folder (videos and their same-name
 * .jpg / .txt), the Drive client that read it, and the ids already posted.
 * { funnel, resolved, providers, folder, files, posted: [driveId], drive }.
 */
export async function folderFiles({ funnelId }) {
  const { funnel, resolved, cfg } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id);
  const sources = await sourcesRepo.listByFunnel(funnel.id).catch(() => []);
  const folder = readyFolder(cfg, resolved) || (sources.find((x) => x.type === 'drive_folder') || {}).ref || '';
  const drive = driveFor(providers, '');
  const files = folder ? await drive.listFiles(folder) : [];
  const posted = await instanceRepo.postedDriveIds(funnel.id, funnel.tenant_id).catch(() => []);
  return { funnel, resolved, cfg, providers, folder, files, posted, drive };
}

/**
 * The router's unattended path through the transcript gate: the Whisper text
 * is kept as it is and approved (the operator approves the finished copy
 * instead, in one email). The thumbnail headline comes from the AI copy.
 * A blank transcript is never approved, unless the video is a comparison (its
 * copy comes from the facts): returns null and the video waits for the operator.
 */
export async function approveTranscriptAuto({ funnelId, driveId, name = '' }) {
  const { funnel } = await loadFunnel(funnelId);
  const { inst, steps: base } = await ensureInstance({ funnel, driveId: String(driveId), name });
  const tArt = ((base.find((x) => x.key === 'transcript') || {}).artifacts) || {};
  if (!String(tArt.text || '').trim()) {
    const providers = await buildProviders(funnel.tenant_id || 'default');
    if (!comparisonFor({ settings: providers.resolved.comparison, name, choice: tArt.comparison })) return null;
  }
  const steps = patchStep(base, 'transcript', { artifacts: { approvedAt: new Date().toISOString(), approvedBy: 'router' } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setStatus(inst.id, 'draft');
  await stepLog.end(inst.id, 'review_transcript', { by: 'router' });
  return inst.id;
}

export default {
  setComparison, savedTranscript, silentDriveIds, onPosted, startPost, postStatus, refreshScheduled, refreshAllTenants, retryFailed, autoRetryDue, unscheduleInstance, listReadyVideos, instanceView, removeSource, videoDurations, transcribeVideo, startTranscribe, transcribeStatus, saveTranscript, generateCopy, generateThumbnail, saveDraftEdit, startClean, cleanStatus, cleanHookJob, cleanHookToken, cleanHookCard, cleanHookProgress, cleanHookDone, cleanHookFail, cleanForRouter, startFixScheduled, fixStatus, postSelections, folderFiles, approveTranscriptAuto,
};
