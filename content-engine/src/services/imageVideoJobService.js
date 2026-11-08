/**
 * Image-post videos on GitHub Actions (Lane 3 of the daily router).
 *
 * Purpose:      Make an image post's whole video on a GitHub runner, so Railway
 *               spends no ffmpeg memory and almost no egress: the runner draws
 *               the three pictures (OpenAI), reads the caption in the funnel's
 *               voice (ElevenLabs, with timings for the subtitles), renders one
 *               video per size and puts every file in the user's Drive app
 *               folder, then calls back. Same workflow and ticket as ✂ Clean
 *               (clean-video.yml, scripts/gha-clean.mjs), ticket kind 'imagevideo'.
 * Responsibility:
 *               - start: sign the ticket, dispatch the workflow, hold the
 *                 heartbeat; give up after HOLD_MAX_MS (counts as a failure).
 *               - hookJob / hookToken / hookProgress / hookDone / hookFail:
 *                 the callbacks (routed here by modules/cleanHooks).
 *               - done → the files are public and handed to the image lane
 *                 (imageLaneService.githubDone), which opens the approval. fail
 *                 → the image lane's fail-safe (imageLaneService.githubFailed).
 *               The job's details live on the instance (images step, artifacts.job),
 *               not in the ticket; the ticket only names the instance.
 * Dependencies: driveConnectService, providerFactory, instanceService, instanceRepository,
 *               core/heartbeat, publicDriveProvider, utils/{cleanHookSpec,shortSpec,
 *               imageGateSpec}, logger.
 */
import * as driveConnect from './driveConnectService.js';
import * as instanceService from './instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as heartbeat from '../core/heartbeat.js';
import { publicDlUrl } from '../providers/publicDriveProvider.js';
import { signTicket, peekTicket, readTicket, dispatchRequest, DEFAULT_REPO } from '../utils/cleanHookSpec.js';
import { IMAGE_VIDEO_SIZES, pickMusic } from '../utils/shortSpec.js';
import { imageSpec } from '../utils/imageGateSpec.js';
import { HookError } from './readyPostService.js';
import { buildProviders } from './providerFactory.js';
import { expandMusic } from './musicFolderService.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'imageVideoJob' });

export const KIND = 'imagevideo';
const HOLD_MAX_MS = 60 * 60 * 1000;
const holds = new Map();

/** The image lane's continuation, loaded when needed (the lane imports this module). */
const lane = () => import('./imageLaneService.js');
const handlers = {
  done: async (id, result) => (await lane()).githubDone(id, result),
  fail: async (id, error) => (await lane()).githubFailed(id, error),
};

function release(instanceId) {
  const h = holds.get(instanceId);
  if (h) { holds.delete(instanceId); h(); }
}

function hold(instanceId) {
  release(instanceId);
  const free = heartbeat.hold('imagevideo');
  // No word from GitHub within the hour: treat it as failed (the fail-safe takes over).
  const cap = setTimeout(() => {
    release(instanceId);
    handlers.fail(instanceId, 'GitHub did not finish within an hour').catch((err) => log.warn({ err: err.message }, 'timeout handler failed'));
  }, HOLD_MAX_MS);
  cap.unref?.();
  holds.set(instanceId, () => { clearTimeout(cap); free(); });
}

export const isTicket = (ticket) => (peekTicket(ticket) || {}).k === KIND;

const imagesArt = (inst) => ((instanceService.parseSteps(inst).find((s) => s.key === 'images') || {}).artifacts) || {};

/**
 * Send the whole video job to GitHub. job: { prompts: size -> prompt, sizes,
 * text, voiceId, music, folderId, name } is saved on the instance first.
 * Resolves once the run is queued; throws when GitHub can't take it.
 */
export async function start({ instance, providers, job, baseUrl }) {
  const tenantId = instance.tenant_id || 'default';
  const c = providers.resolved.clean || {};
  if (!c.githubToken) throw new Error('no GitHub token (Keys and credit, Video clean)');
  if (!(providers.resolved.openai || {}).apiKey) throw new Error('GitHub draws the pictures with OpenAI, and there is no OpenAI key');
  if (!(await driveConnect.status(tenantId)).connected) throw new Error('Google Drive is not connected (Setup, Settings, Google)');
  if (!/^https:\/\//.test(baseUrl || '')) throw new Error("the app's public https address is not set, so GitHub can't call back");
  await instanceService.updateStep(instance.id, 'images', { artifacts: { ...imagesArt(instance), job: { ...job, runner: 'github', startedAt: new Date().toISOString() } } });
  const ticket = signTicket({ t: tenantId, k: KIND, d: instance.id }, await driveConnect.hookSecret(tenantId));
  const ref = c.githubRef || process.env.RAILWAY_GIT_BRANCH || 'main';
  const { url, init } = dispatchRequest({ repo: c.githubRepo || DEFAULT_REPO, token: c.githubToken, ref, hook: baseUrl, ticket });
  const res = await fetch(url, init);
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message || msg; } catch { /* keep the raw text */ }
    throw new Error(`GitHub refused to start the video (${res.status}): ${msg || 'no reason given'}`);
  }
  hold(instance.id);
  log.info({ instance: instance.id, sizes: job.sizes, ref }, 'image-post video sent to GitHub Actions');
}

async function ticketOf(ticket) {
  const peek = peekTicket(ticket);
  if (!peek || !peek.t || peek.k !== KIND) throw new HookError('bad ticket');
  const p = readTicket(ticket, await driveConnect.hookSecret(peek.t));
  if (!p || !p.d) throw new HookError('ticket is invalid or expired');
  return p;
}

async function jobOf(p) {
  const inst = await instanceRepo.get(p.d);
  if (!inst || String(inst.tenant_id) !== String(p.t)) throw new HookError('instance not found');
  const job = imagesArt(inst).job;
  if (!job || job.runner !== 'github') throw new HookError('no GitHub video job on this instance');
  return { inst, job };
}

/**
 * Everything the runner needs. The OpenAI and ElevenLabs keys travel only
 * here, to the holder of a valid ticket, and the runner masks them in its log.
 */
export async function hookJob({ ticket }) {
  const p = await ticketOf(ticket);
  const { job } = await jobOf(p);
  const r = (await buildProviders(p.t)).resolved || {};
  const { token, folderId } = await driveConnect.drive(p.t);
  const sizes = (job.sizes || []).filter((s) => IMAGE_VIDEO_SIZES[s]);
  return {
    kind: KIND,
    sizes,
    specs: Object.fromEntries(sizes.map((s) => {
      const spec = IMAGE_VIDEO_SIZES[s];
      const gen = imageSpec(spec.gen);
      return [s, { w: spec.w, h: spec.h, genSize: gen.size, aspect: gen.aspect || spec.label }];
    })),
    prompts: job.prompts || {},
    imageModel: (r.openai || {}).imageModel || 'gpt-image-1',
    openaiKey: (r.openai || {}).apiKey || '',
    text: job.text || '',
    voiceId: job.voiceId || '',
    voiceModel: 'eleven_multilingual_v2',
    elevenlabsKey: ((r.tts || {}).elevenlabsApiKey) || '',
    music: pickMusic(await expandMusic(r.shortMusic || {})),
    accessToken: token,
    folderId,
    name: job.name || `image post ${String(p.d).slice(0, 8)}`,
  };
}

export async function hookToken({ ticket }) {
  const p = await ticketOf(ticket);
  const { token, folderId } = await driveConnect.drive(p.t);
  return { accessToken: token, folderId };
}

export async function hookProgress({ ticket, phase, pct }) {
  const p = await ticketOf(ticket);
  log.info({ instance: p.d, phase, pct }, 'image-post video progress');
  return { ok: true };
}

/** Every file is in the app's Drive folder: share them and hand over to the image lane. */
export async function hookDone({ ticket, body = {} }) {
  const p = await ticketOf(ticket);
  const { inst } = await jobOf(p);
  const { client, folderId } = await driveConnect.drive(p.t);
  const ids = { ...(body.images || {}), ...Object.fromEntries(Object.entries(body.videos || {}).map(([k, v]) => [`v_${k}`, v])) };
  for (const id of Object.values(ids)) {
    if (!/^[\w-]{10,}$/.test(String(id || ''))) throw new HookError('bad file id');
    const meta = await client.fileMeta(id);
    if (folderId && Array.isArray(meta.parents) && !meta.parents.includes(folderId)) throw new HookError('file is not in the app folder');
    await client.makePublic(id);
  }
  const urls = (m) => Object.fromEntries(Object.entries(m || {}).map(([k, id]) => [k, publicDlUrl(id)]));
  release(p.d);
  log.info({ instance: p.d, videos: Object.keys(body.videos || {}) }, 'image-post video made on GitHub Actions');
  await handlers.done(inst.id, {
    runner: 'github',
    images: urls(body.images),
    imageIds: body.images || {},
    videos: urls(body.videos),
    videoIds: body.videos || {},
    seconds: Number(body.seconds) || 0,
    chars: Number(body.chars) || 0,
    made: Number(body.made) || 0,
    subtitled: !!body.subtitled,
    subtitleError: String(body.subtitleError || '').slice(0, 200),
    musicCredit: String(body.musicCredit || '').slice(0, 300),
  });
  return { ok: true };
}

export async function hookFail({ ticket, error }) {
  const p = await ticketOf(ticket);
  release(p.d);
  const msg = String(error || 'the GitHub run failed').slice(0, 400);
  log.warn({ instance: p.d, error: msg }, 'GitHub image-post video failed');
  await handlers.fail(p.d, `GitHub: ${msg}`);
  return { ok: true };
}

export default { KIND, isTicket, start, hookJob, hookToken, hookProgress, hookDone, hookFail };
