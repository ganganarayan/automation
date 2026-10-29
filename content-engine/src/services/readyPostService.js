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
import { THUMB_SPECS, thumbSvg, thumbImagePrompt } from '../utils/thumbSpec.js';
import sharp from 'sharp';
import { formatIst } from '../utils/time.js';
import { driveEmbedUrl } from '../utils/reviewSpec.js';
import {
  filterReadyVideos,
  defaultCaption,
  defaultSlotsIso,
  parseIstDateTime,
  normalizeSelections,
} from '../utils/readyPostSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'readyPost' });

async function loadFunnel(funnelId) {
  const funnel = await funnels.get(Number(funnelId));
  if (!funnel) throw new Error(`funnel ${funnelId} not found`);
  const resolved = await funnels.resolve(funnel);
  const cfg = await funnels.getConfig(funnel.id).catch(() => ({}));
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
  if (picked && picked.length) return { ...base, folder: '', picked: true, videos: picked };
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
  return { ...base, videos, totalFiles: files.length };
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
export async function generateCopy({ tenantId = 'default', funnelId, driveId, name = '', transcript: pasted = '', accessToken = '' }) {
  if (!driveId) throw new Error('driveId required');
  const { funnel, resolved, cfg } = await loadFunnel(funnelId);
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
    costs.push({ step: 'transcript', ...costTranscript({ provider: tp.provider, minutes: t.minutes }) });
  }

  const { data, model, usage } = await providers.llm.generateJsonDetailed({
    system: copySystemPrompt({ brief: cfg && cfg.direct_copy_brief, audience: resolved.audiencePrefix, keyword: resolved.captureKeyword }),
    user: copyUserPrompt({ transcript, fileName: name }),
    maxTokens: 8000,
  });
  costs.push({ step: 'script', ...costText({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model }) });
  const copy = normalizeCopy(data);
  if (!copy.title && !copy.description) throw new Error('the model returned empty copy — try again');
  log.info({ funnel: funnel.name, driveId, words: transcript.split(/\s+/).filter(Boolean).length }, 'ready video copy generated');

  // Thumbnails: one design per platform. A failure here never loses the copy —
  // those platforms just fall back to the video's first frame.
  let thumbs = {};
  let thumbError = '';
  try {
    const platforms = thumbPlatforms(resolved);
    // AI artwork from the image prompt — one landscape and (if needed) one
    // portrait image, cropped per platform. A failed image falls back to a frame.
    const imageModel = /^gpt-image/.test(String(providers.resolved.openai?.imageModel || '')) ? providers.resolved.openai.imageModel : 'gpt-image-1';
    const art = {};
    const needs = [['landscape', '1536x1024'], ['portrait', '1024x1536']]
      .filter(([o]) => platforms.some((k) => (THUMB_SPECS[k].h > THUMB_SPECS[k].w) === (o === 'portrait')));
    for (const [orientation, size] of needs) {
      try {
        art[orientation] = await providers.llm.generateImage({ prompt: thumbImagePrompt(copy.thumbPrompt || copy.title, orientation), size, model: imageModel });
        costs.push({ step: 'images', ...costImages({ count: 1, size, model: imageModel }) });
      } catch (err) {
        log.warn({ err: err.message, orientation }, 'thumbnail artwork failed (using a video frame)');
        thumbError = `artwork: ${err.message}`;
      }
    }
    let frame = null;
    if (needs.some(([o]) => !art[o])) {
      frame = video
        ? await ffmpeg.extractFrame({ videoBuffer: video, ext })
        : await ffmpeg.extractFrame({ url: publicDlUrl(driveId) }).catch(async () => ffmpeg.extractFrame({ videoBuffer: await getVideo(), ext }));
    }
    thumbs = await renderThumbs({ providers, platforms, art, frame, text: copy.thumbText || copy.title });
  } catch (err) {
    thumbError = err.message;
    log.warn({ err: err.message, driveId }, 'thumbnail generation failed (first frame will be used)');
  }
  return { copy, transcript, costs, transcribed: audio.length > 0, thumbs, thumbError };
}

/**
 * Render each platform's thumbnail design (its crop of the AI artwork, else the
 * video frame) and upload it to Post for Me. Returns { platform: publicUrl }.
 */
async function renderThumbs({ providers, platforms, art, frame, text }) {
  const postformeKey = providers.resolved.postformeKey || '';
  if (!postformeKey) throw new Error('No Post for Me API key — set it under Settings → API Keys');
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);
  const out = {};
  for (const k of platforms) {
    const spec = THUMB_SPECS[k];
    const base = (spec.h > spec.w ? art.portrait : art.landscape) || frame;
    if (!base) continue; // no artwork and no frame => this platform uses the first frame
    const jpg = await sharp(base)
      .resize(spec.w, spec.h, { fit: 'cover', position: 'attention' })
      .composite([{ input: Buffer.from(thumbSvg({ ...spec, text })) }])
      .jpeg({ quality: 86 })
      .toBuffer();
    out[k] = await publish.uploadMedia(jpg, 'image/jpeg');
  }
  log.info({ platforms }, 'thumbnails rendered + uploaded');
  return out;
}

/** The platforms this funnel posts to that have a thumbnail spec (all, if unknown). */
function thumbPlatforms(resolved) {
  const accountMap = resolved.accountMap || {};
  const present = [...new Set((resolved.accounts || []).map((id) => platformKey((accountMap[id] || {}).platform)).filter(Boolean))];
  return (present.length ? present : Object.keys(THUMB_SPECS)).filter((k) => THUMB_SPECS[k]);
}

/** Record one direct post as a posted instance (stages skipped; AI-copy cost if any). */
async function recordPostedInstance({ funnel, driveId, caption, scheduledIso, ref, copy = null, costs = [] }) {
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
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { driveId } } });
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: ref ? [ref] : [], caption } });
  await instanceRepo.saveSteps(inst.id, steps, sumInstanceCost(steps));
  await instanceRepo.lockAsPosted(inst.id, { postRefs: ref ? [ref] : [], postedAt: scheduledIso ? new Date(scheduledIso) : new Date() });
  return inst.id;
}

/**
 * Post the tick-selected videos, in selection order, each at its own schedule
 * (explicit "DD-MM-YYYY HH:MM" IST, else the next sequential daily slot). Sends a
 * posted-summary email. Returns a per-item result list.
 */
export async function postSelections({ tenantId = 'default', funnelId, selections, accessToken = '' }) {
  const { funnel, resolved, cfg } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const drive = driveFor(providers, accessToken);
  const clean = normalizeSelections(selections);
  if (!clean.length) throw new Error('no videos selected');

  // The Post for Me key is central (API Keys page); the funnel picks the accounts.
  const postformeKey = providers.resolved.postformeKey || '';
  if (!postformeKey) throw new Error('No Post for Me API key — set it once under Settings → API Keys');
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  if (!accounts.length) throw new Error('This funnel has no Post for Me accounts configured');
  const publish = createPostForMeProvider({ apiKey: postformeKey }, log);

  // YouTube needs a title. When any selected account is a YouTube one and the
  // funnel has a direct_yt_title, pass it as a per-platform configuration (the
  // caption serves as the YouTube description; IG/LinkedIn use the caption too).
  const accountMap = resolved.accountMap || {};
  const hasYoutube = accounts.some((id) => String((accountMap[id] || {}).platform || '').toLowerCase().includes('youtube'));
  const ytTitle = String((cfg && cfg.direct_yt_title) || '').trim();
  const platformConfigurations = hasYoutube && ytTitle ? { youtube: { title: ytTitle } } : undefined;

  const slots = defaultSlotsIso(resolved.publishTime, clean.length);
  const results = [];
  for (let i = 0; i < clean.length; i += 1) {
    const sel = clean[i];
    // "Post now" => no scheduled_at, so Post-for-Me publishes immediately.
    const scheduledIso = sel.now ? null : ((sel.scheduledAt && parseIstDateTime(sel.scheduledAt)) || slots[i] || null);
    // AI-copy lane: each platform gets its own copy for this video.
    const ai = sel.copy ? platformConfigsFor(sel.copy, { accountIds: accounts, accountMap, ctaLink: resolved.ctaLink, videoUrl: publicDlUrl(sel.driveId), thumbs: sel.thumbs }) : null;
    const caption = ai ? ai.caption : (sel.caption.trim() || captionFor(cfg, resolved));
    try {
      await drive.shareAnyone(sel.driveId);
      const result = await publish.createPost({
        accountIds: accounts,
        caption,
        mediaUrl: publicDlUrl(sel.driveId),
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

export default { listReadyVideos, generateCopy, postSelections };
