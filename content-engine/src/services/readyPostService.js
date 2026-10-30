/**
 * Ready-video direct post service.
 *
 * Purpose:      The "pick already-made videos from the funnel's Drive folder and
 *               post them directly via Post-for-Me" path — bypassing the whole
 *               generation pipeline (research/script/images/animate/voiceover/
 *               transcript/stitch). The operator tick-selects unposted videos,
 *               gives each a caption and a schedule, and they post in selection
 *               order. No review email (the video is finished) — a posted-summary
 *               email is sent afterwards. Each post is recorded as a posted
 *               instance so it shows in the same log, with its stages marked
 *               skipped and zero AI cost.
 *
 *               AI-copy lane: the same picker, but per video the app first
 *               downloads the file, transcribes its audio and writes the YouTube
 *               title + description (also the LinkedIn / Facebook post), the
 *               Instagram caption and a short Threads / X post. The operator
 *               edits them, then posts — each platform gets its own copy.
 * Responsibility: Orchestration + side effects; pure logic in utils/readyPostSpec
 *               and utils/aiCopySpec.
 * Dependencies: funnelsRepository, instanceService, instanceRepository,
 *               providerFactory, publishProvider, storageProvider, instanceSpec,
 *               utils/{readyPostSpec,reviewSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceService from '../services/instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { createTranscriptProvider } from '../providers/transcriptProvider.js';
import { createFfmpegProvider } from '../providers/ffmpegProvider.js';
import { createGoogleDriveProvider } from '../providers/storageProvider.js';
import { createPublicDriveProvider, publicDlUrl } from '../providers/publicDriveProvider.js';
import * as captureRules from './captureRules.js';
import { buildInitialSteps, patchStep, addCostToSteps, sumInstanceCost } from '../utils/instanceSpec.js';
import { costText, costTranscript, costImages } from '../utils/pricing.js';
import { copySystemPrompt, copyUserPrompt, normalizeCopy, platformConfigsFor, platformKey } from '../utils/aiCopySpec.js';
import { THUMB_SPECS, THUMB_SIZES, PLATFORM_SIZE, THUMB_ACCENT, thumbSvg, thumbImagePrompt } from '../utils/thumbSpec.js';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCleanOpts } from '../utils/cleanSpec.js';
import { formatIst } from '../utils/time.js';
import { driveEmbedUrl } from '../utils/reviewSpec.js';
import {
  filterReadyVideos,
  defaultCaption,
  defaultSlotsIso,
  parseIstDateTime,
  normalizeSelections,
  normalizePickedAccounts,
} from '../utils/readyPostSpec.js';
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
 *  else the funnel media folder). */
function readyFolder(cfg, resolved) {
  return (cfg && cfg.direct_drive_folder) || resolved.driveFolder || '';
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
 * else the unposted videos in a Drive folder, newest first — the folder the
 * operator pasted on the page (`folder`), else the funnel's ready-videos folder.
 * Also returns the picker settings, the service-account email a folder must be
 * shared with, and the Drive error (if listing failed) so the page can say
 * what's wrong.
 */
export async function listReadyVideos({ tenantId = 'default', funnelId, folder: override = '', picked = [] }) {
  const { funnel, resolved, cfg } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const folder = override || readyFolder(cfg, resolved);
  const g = providers.resolved.google || {};
  const saEmail = (g.serviceAccount && g.serviceAccount.client_email) || '';
  const picker = { clientId: g.oauthClientId || '', apiKey: g.pickerApiKey || '', appId: g.projectNumber || '' };
  const base = { funnel, resolved, cfg, folder, saEmail, picker, defaultCaption: captionFor(cfg, resolved) };
  if (picked && picked.length) return { ...base, folder: '', picked: true, videos: picked, drafts: await loadDrafts(funnel, picked.map((f) => f.id)) };
  if (!folder) return { ...base, videos: [] };
  let files;
  try {
    files = await driveFor(providers, '').listFiles(folder);
  } catch (err) {
    log.warn({ err: err.message, folder }, 'ready folder list failed');
    return { ...base, videos: [], listError: err.message };
  }
  // Posted files are hidden by the app's own record too — a public folder
  // can't be renamed "POSTED".
  const posted = new Set(await instanceRepo.postedDriveIds(funnel.id, funnel.tenant_id).catch(() => []));
  const videos = filterReadyVideos(files)
    .filter((f) => !posted.has(f.id))
    .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime }))
    .sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0));
  return { ...base, videos, totalFiles: files.length, drafts: await loadDrafts(funnel, videos.map((v) => v.id)) };
}

// Video lengths by Drive id — a file's length never changes, so probe once.
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

/**
 * AI-copy lane: download one ready video, transcribe it and write its copy.
 * A pasted `transcript` (or any text) skips the download + transcription.
 * Returns { copy, transcript, costs, transcribed } — costs are the real
 * transcription and token costs, carried back with the selection and recorded
 * on the instance.
 */
export async function generateCopy({ tenantId = 'default', funnelId, driveId, name = '', transcript: pasted = '', accessToken = '', accounts: pickedAccounts = null }) {
  if (!driveId) throw new Error('driveId required');
  const { funnel, resolved, cfg } = await loadFunnel(funnelId, pickedAccounts);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const costs = [];

  // A pasted transcript / text skips the download + transcription entirely.
  let transcript = String(pasted || '').trim();
  const ext = ((String(name).match(/\.(\w{2,4})$/) || [])[1] || 'mp4').toLowerCase();
  const ffmpeg = createFfmpegProvider({}, log);
  let video = null; // downloaded only when transcription (or a non-public file) needs it
  const getVideo = async () => video || (video = await driveFor(providers, accessToken).download(driveId));
  const audio = transcript ? Buffer.alloc(0) : await ffmpeg.extractAudio({ videoBuffer: await getVideo(), ext });
  if (audio.length) {
    if (audio.length > WHISPER_MAX_BYTES) throw new Error('video audio is too long to transcribe (over ~70 minutes)');
    const tp = createTranscriptProvider({ apiKey: providers.resolved.transcriptKey || providers.resolved.openai.apiKey }, log);
    const t = await tp.transcribe({ buffer: audio, filename: 'audio.mp3' });
    transcript = t.text;
    if (t.durationSeconds > 0) durationCache.set(driveId, Math.round(t.durationSeconds));
    costs.push({ step: 'transcript', ...costTranscript({ provider: tp.provider, minutes: t.minutes }) });
  }

  const { data, model, usage } = await providers.llm.generateJsonDetailed({
    system: copySystemPrompt({ brief: cfg && cfg.direct_copy_brief, audience: resolved.audiencePrefix, keyword: resolved.captureKeyword, base: providers.resolved.prompts.copy }),
    user: copyUserPrompt({ transcript, fileName: name }),
    maxTokens: 8000,
  });
  costs.push({ step: 'script', ...costText({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model }) });
  const copy = normalizeCopy(data);
  if (!copy.title && !copy.description) throw new Error('the model returned empty copy — try again');
  log.info({ funnel: funnel.name, driveId, words: transcript.split(/\s+/).filter(Boolean).length }, 'ready video copy generated');

  // Thumbnails: one AI artwork, rendered in three sizes with the hook as the
  // headline. A failure here never loses the copy — the video's first frame is
  // used instead.
  let thumbs = {};
  let sizes = [];
  let thumbError = '';
  try {
    const platforms = thumbPlatforms(resolved);
    const imageModel = /^gpt-image/.test(String(providers.resolved.openai?.imageModel || '')) ? providers.resolved.openai.imageModel : 'gpt-image-1';
    let base = null;
    try {
      base = await providers.llm.generateImage({ prompt: thumbImagePrompt(copy.thumbPrompt || copy.title), size: '1024x1024', model: imageModel });
      costs.push({ step: 'images', ...costImages({ count: 1, size: '1024x1024', model: imageModel }) });
    } catch (err) {
      log.warn({ err: err.message }, 'thumbnail artwork failed (using a video frame)');
      thumbError = `artwork: ${err.message}`;
    }
    if (!base) {
      base = video
        ? await ffmpeg.extractFrame({ videoBuffer: video, ext })
        : await ffmpeg.extractFrame({ url: publicDlUrl(driveId) }).catch(async () => ffmpeg.extractFrame({ videoBuffer: await getVideo(), ext }));
    }
    ({ thumbs, sizes } = await renderThumbs({ providers, platforms, base, text: copy.thumbText || copy.title }));
  } catch (err) {
    thumbError = err.message;
    log.warn({ err: err.message, driveId }, 'thumbnail generation failed (first frame will be used)');
  }
  const instanceId = await saveDraft({ funnel, driveId, transcript, copy, thumbs, sizes, thumbError, costs }).catch((err) => {
    log.warn({ err: err.message, driveId }, 'draft save failed (generation still returned)');
    return null;
  });
  return { copy, transcript, costs, transcribed: audio.length > 0, thumbs, sizes, thumbError, instanceId };
}

/**
 * Render the artwork in each size the funnel's platforms need (cover crop + the
 * hook headline) and upload it to Post for Me. Returns { thumbs: platform ->
 * url, sizes: [{ size, label, url, platforms }] }.
 */
async function renderThumbs({ providers, platforms, base, text }) {
  const postformeKey = providers.resolved.postformeKey || '';
  if (!postformeKey) throw new Error('No Post for Me API key — set it under Settings → API Keys');
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);
  const thumbs = {};
  const sizes = [];
  for (const [size, spec] of Object.entries(THUMB_SIZES)) {
    const users = platforms.filter((k) => PLATFORM_SIZE[k] === size);
    if (!users.length) continue;
    const jpg = await sharp(base)
      .resize(spec.w, spec.h, { fit: 'cover', position: 'attention' })
      .composite([{ input: Buffer.from(thumbSvg({ ...spec, accent: THUMB_ACCENT, text })) }])
      .jpeg({ quality: 86 })
      .toBuffer();
    const url = await publish.uploadMedia(jpg, 'image/jpeg');
    for (const k of users) thumbs[k] = url;
    sizes.push({ size, label: spec.label, url, platforms: users });
  }
  log.info({ sizes: sizes.map((x) => x.label) }, 'thumbnails rendered + uploaded');
  return { thumbs, sizes };
}

/** The platforms this funnel posts to that have a thumbnail spec (all, if unknown). */
function thumbPlatforms(resolved) {
  const accountMap = resolved.accountMap || {};
  const present = [...new Set((resolved.accounts || []).map((id) => platformKey((accountMap[id] || {}).platform)).filter(Boolean))];
  return (present.length ? present : Object.keys(THUMB_SPECS)).filter((k) => THUMB_SPECS[k]);
}

/** The stitch step's video artifact, keeping what's already there (e.g. the cleaned copy). */
function videoArt(steps, driveId, durationSec = 0) {
  const prev = ((steps.find((x) => x.key === 'stitch') || {}).artifacts || {}).video || {};
  return { ...prev, driveId, ...(durationSec ? { durationSec } : {}) };
}

// ✂ Clean jobs by Drive id: { state: running | done | failed, clean?, error? }.
// In memory only — a restart loses a running job (just press Clean again);
// a finished one is saved on the video's draft instance.
const cleanJobs = new Map();

/**
 * Start cleaning one ready video in the background (zoom from the top so the
 * corner watermark leaves the frame, cut the outro), then upload it to Post for
 * Me. The page polls cleanStatus.
 */
export async function startClean({ funnelId, driveId, zoomPct, trimEndSec }) {
  if (!driveId) throw new Error('driveId required');
  const id = String(driveId);
  const { funnel } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id);
  if (!providers.resolved.postformeKey) throw new Error('No Post for Me API key — set it under Settings → API Keys');
  const job = cleanJobs.get(id);
  if (job && job.state === 'running') return job;
  const opts = normalizeCleanOpts({ zoomPct, trimEndSec });
  const running = { state: 'running', startedAt: Date.now(), ...opts };
  cleanJobs.set(id, running);
  runClean({ funnel, providers, driveId: id, opts })
    .then((clean) => cleanJobs.set(id, { state: 'done', clean }))
    .catch((err) => {
      log.error({ err: err.message, driveId: id }, 'video clean failed');
      cleanJobs.set(id, { state: 'failed', error: err.message });
    });
  return running;
}

async function runClean({ funnel, providers, driveId, opts }) {
  const total = (await videoDurations([driveId]))[driveId] || 0;
  if (opts.trimEndSec && !total) throw new Error("couldn't read the video's length to trim its end");
  const keepSec = opts.trimEndSec ? Math.max(1, total - opts.trimEndSec) : 0;
  const dir = await mkdtemp(join(tmpdir(), 'clean-'));
  try {
    const outPath = join(dir, 'clean.mp4');
    const t0 = Date.now();
    await createFfmpegProvider({}, log).cleanVideo({ url: publicDlUrl(driveId), outPath, zoomPct: opts.zoomPct, keepSec });
    const url = await createPostForMeProvider({ apiKey: providers.resolved.postformeKey }, log).uploadFile(outPath, 'video/mp4');
    const clean = { url, ...opts, durationSec: Math.round(keepSec || total), at: new Date().toISOString() };
    await saveClean(funnel, driveId, clean);
    log.info({ driveId, ...opts, seconds: Math.round((Date.now() - t0) / 1000) }, 'video cleaned + uploaded');
    return clean;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keep the cleaned video on the video's draft instance (made if there's none yet). */
async function saveClean(funnel, driveId, clean) {
  const existing = (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [driveId]))[driveId];
  const inst = existing || await instanceService.createForFunnel({ tenantId: funnel.tenant_id, funnel, title: 'Ready video (cleaned)', status: 'draft' });
  let steps = existing ? instanceService.parseSteps(existing) : buildInitialSteps();
  if (!existing) for (const k of ['animate', 'voiceover']) steps = patchStep(steps, k, { status: 'skipped' });
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { ...videoArt(steps, driveId, clean.durationSec), clean } } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.setMeta(inst.id, { durationSeconds: clean.durationSec || undefined });
}

/** Where a clean job stands (running / done / failed), else the saved cleaned video. */
export async function cleanStatus({ funnelId, driveId }) {
  const job = cleanJobs.get(String(driveId));
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
async function saveDraft({ funnel, driveId, transcript, copy, thumbs, sizes, thumbError, costs, edit = false }) {
  const existing = (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [driveId]))[driveId];
  const inst = existing || await instanceService.createForFunnel({ tenantId: funnel.tenant_id, funnel, title: copy.title || 'Ready video', status: 'draft' });
  let steps = existing ? instanceService.parseSteps(existing) : buildInitialSteps();
  if (!existing) for (const k of ['animate', 'voiceover']) steps = patchStep(steps, k, { status: 'skipped' });
  const at = new Date().toISOString();
  const prev = ((steps.find((x) => x.key === 'script') || {}).artifacts || {}).generations || [];
  // A manual save (edits) updates the current copy; only a real generation is
  // added to the history.
  const generations = edit ? prev : [...prev, { at, copy, thumbs, sizes, thumbError }].slice(-20);
  steps = patchStep(steps, 'transcript', { status: transcript ? 'done' : 'skipped', artifacts: { text: transcript } });
  steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: copy.description, copy, generations } });
  if (sizes.length || !edit) steps = patchStep(steps, 'images', { status: sizes.length ? 'done' : 'skipped', artifacts: { thumbs, sizes } });
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
 * transcript, thumbnails) without regenerating. Thumbnails sent only as
 * platform -> url are grouped back into their sizes.
 */
export async function saveDraftEdit({ funnelId, driveId, transcript = '', copy, thumbs = {}, sizes = [], costs = [] }) {
  if (!driveId) throw new Error('driveId required');
  const { funnel } = await loadFunnel(funnelId);
  const clean = normalizeCopy(copy);
  if (!clean.title && !clean.description) throw new Error('nothing to save — generate or write the copy first');
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
  const instanceId = await saveDraft({ funnel, driveId: String(driveId), transcript: String(transcript || ''), copy: clean, thumbs: urls, sizes: grouped, thumbError: '', costs: okCosts, edit: true });
  return { instanceId };
}

/** The saved AI drafts for these videos, for the page to restore: { driveId: draft }. */
async function loadDrafts(funnel, driveIds) {
  const rows = await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, driveIds).catch(() => ({}));
  const out = {};
  for (const [driveId, row] of Object.entries(rows)) {
    const steps = instanceService.parseSteps(row);
    const art = (k) => (steps.find((x) => x.key === k) || {}).artifacts || {};
    const costUsd = steps.reduce((t, x) => t + (x.costs || []).reduce((u, c) => u + (Number(c.costUsd) || 0), 0), 0);
    const clean = (art('stitch').video || {}).clean || null;
    if (!art('script').copy && !clean) continue;
    out[driveId] = { instanceId: row.id, clean, copy: art('script').copy || null, transcript: art('transcript').text || '', thumbs: art('images').thumbs || {}, sizes: art('images').sizes || [], costUsd, atIst: formatIst(row.updated_at) };
  }
  return out;
}

/** Record one direct post as a posted instance (stages skipped; AI-copy cost if any). */
async function recordPostedInstance({ funnel, driveId, caption, scheduledIso, ref, copy = null, costs = [], durationSec = 0 }) {
  const draft = copy ? (await instanceRepo.draftsByDriveIds(funnel.id, funnel.tenant_id, [driveId]).catch(() => ({})))[driveId] : null;
  if (draft) {
    // The generation (and its cost) is already on the draft — finish it.
    let steps = instanceService.parseSteps(draft);
    steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: copy.description, copy } });
    steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: videoArt(steps, driveId, durationSec) } });
    steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: ref ? [ref] : [], caption } });
    await instanceRepo.saveSteps(draft.id, steps, sumInstanceCost(steps));
    await instanceRepo.setMeta(draft.id, {
      title: `${copy.title || 'Ready video'} — ${scheduledIso ? formatIst(scheduledIso, { withTime: false }) : 'now'}`,
      durationSeconds: durationSec || undefined,
      scheduledFor: scheduledIso ? new Date(scheduledIso) : undefined,
    });
    await instanceRepo.lockAsPosted(draft.id, { postRefs: ref ? [ref] : [], postedAt: scheduledIso ? new Date(scheduledIso) : new Date() });
    return draft.id;
  }
  const inst = await instanceService.createForFunnel({
    tenantId: funnel.tenant_id,
    funnel,
    title: `${copy && copy.title ? copy.title : 'Ready video'} — ${scheduledIso ? formatIst(scheduledIso, { withTime: false }) : 'now'}`,
    scheduledFor: scheduledIso ? new Date(scheduledIso) : null,
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
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: ref ? [ref] : [], caption } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  if (durationSec) await instanceRepo.setMeta(inst.id, { durationSeconds: durationSec });
  await instanceRepo.lockAsPosted(inst.id, { postRefs: ref ? [ref] : [], postedAt: scheduledIso ? new Date(scheduledIso) : new Date() });
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
  if (!postformeKey) throw new Error('No Post for Me API key — set it once under Settings → API Keys');
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  if (!accounts.length) throw new Error('No accounts ticked — tick the accounts to post to (top of this page)');
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
    const scheduledIso = sel.now ? null : ((sel.scheduledAt && parseIstDateTime(sel.scheduledAt)) || slots[i] || null);
    // AI-copy lane: each platform gets its own copy for this video.
    const cleaned = (saved[sel.driveId] || {}).clean || null;
    const videoUrl = cleaned ? cleaned.url : publicDlUrl(sel.driveId);
    const ai = sel.copy ? platformConfigsFor(sel.copy, { accountIds: accounts, accountMap, ctaLink: resolved.ctaLink, videoUrl, thumbs: sel.thumbs }) : null;
    const caption = ai ? ai.caption : (sel.caption.trim() || captionFor(cfg, resolved));
    try {
      await drive.shareAnyone(sel.driveId);
      const result = await publish.createPost({
        accountIds: accounts,
        caption,
        mediaUrl: videoUrl,
        scheduledAt: scheduledIso || undefined,
        platformConfigurations: ai ? ai.platformConfigurations : platformConfigurations,
      });
      const ref = result && result.id ? result.id : null;
      // Arm comment-to-DM for this post (funnel-level keyword/dm defaults).
      if (ref && resolved.captureKeyword) {
        await captureRules.createForPublish({
          tenantId: funnel.tenant_id, funnelId: funnel.id, lane: funnel.name,
          platforms: captureRules.dmPlatforms(accounts, accountMap),
          postformePostId: ref,
          keyword: resolved.captureKeyword, dmText: resolved.captureDmText, dmLink: resolved.captureDmLink,
          publicReplyVariants: resolved.capturePublicReplies,
          requireFollow: resolved.captureRequireFollow, followupText: resolved.captureFollowupText,
          notFollowingText: resolved.captureNotFollowingText, log,
        }).catch((err) => log.warn({ err: err.message }, 'capture rule create failed (posted anyway)'));
      }
      const instanceId = await recordPostedInstance({
        funnel, driveId: sel.driveId, caption, scheduledIso, ref,
        copy: sel.copy ? normalizeCopy(sel.copy) : null, costs: sel.costs,
        durationSec: (cleaned && cleaned.durationSec) || (await videoDurations([sel.driveId]))[sel.driveId] || 0,
      });
      try {
        await drive.renameFile(sel.driveId, `POSTED - ${sel.name || sel.driveId}`);
      } catch (err) {
        log.warn({ err: err.message, driveId: sel.driveId }, 'POSTED tag failed (posted anyway)');
      }
      results.push({ driveId: sel.driveId, name: sel.name, scheduledIso, caption, ref, instanceId, ok: true });
      log.info({ funnel: funnel.name, driveId: sel.driveId, scheduledIso, ref }, 'ready video posted');
    } catch (err) {
      log.error({ err: err.message, driveId: sel.driveId }, 'ready video post failed');
      results.push({ driveId: sel.driveId, name: sel.name, ok: false, error: err.message });
    }
  }

  await sendPostedEmail({ providers, funnel, resolved, results });
  return { funnel: funnel.name, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

async function sendPostedEmail({ providers, funnel, resolved, results }) {
  const to = resolved.approvalEmail || providers.resolved?.emails?.approvalGita || '';
  const ok = results.filter((r) => r.ok);
  if (!to || !ok.length) return;
  const rows = ok
    .map(
      (r) => `<tr>
        <td><a href="${esc(driveEmbedUrl(r.driveId))}" target="_blank" rel="noopener">▶ ${esc(r.name || 'video')}</a></td>
        <td>${esc(r.scheduledIso ? formatIst(r.scheduledIso) : 'Now (immediate)')}</td>
        <td><pre style="white-space:pre-wrap;margin:0;font:inherit">${esc(r.caption)}</pre></td>
      </tr>`,
    )
    .join('');
  const html = `<p><b>${esc(String(ok.length))}</b> ready video(s) scheduled for <b>${esc(funnel.name)}</b> via Post for Me.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse">
      <thead><tr><th>Video</th><th>Scheduled (IST)</th><th>Caption</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  try {
    await providers.mail.send({ to, subject: `Posted ${ok.length} ready video(s) — ${funnel.name}`, html });
  } catch (err) {
    log.warn({ err: err.message }, 'posted-summary email failed');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { listReadyVideos, videoDurations, generateCopy, saveDraftEdit, startClean, cleanStatus, postSelections };
