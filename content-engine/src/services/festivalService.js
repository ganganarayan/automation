/**
 * Festival lane: one post to every funnel, outside the daily router.
 *
 * Purpose:      For a festival (Diwali, Holi, New Year...) you upload ONE picture
 *               and write ONE copy; every ticked funnel gets the same voiced video
 *               an image post gets (the copy read aloud in that funnel's voice,
 *               subtitles, music, 9:16 / 4:5 / 16:9) and it goes to all of that
 *               funnel's channels, YouTube Shorts included. It is posted on top of
 *               the day's normal post, never instead of it: the router does not
 *               see festival instances (instanceRepository.liveOnDate skips them).
 * Responsibility:
 *               - upload: the picture to Drive, shared Anyone with the link.
 *               - compose: your background-removed photo placed on the picture
 *                 (standing on the bottom edge), saved as a new picture.
 *               - start: check each funnel (accounts, voice), make one instance per
 *                 funnel (source_type 'festival', source_ref = the batch id) and
 *                 have the image lane make its video, in the background.
 *               - batches: the festival posts grouped by batch, for the page.
 *               - approve / approveAll / retry.
 * Dependencies: imageLaneService, approvalService, instanceRepository,
 *               funnelsRepository, providerFactory, core/heartbeat, logger.
 */
import { randomUUID } from 'node:crypto';
import * as imageLane from './imageLaneService.js';
import * as approvalService from './approvalService.js';
import * as instanceService from './instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as funnels from '../repositories/funnelsRepository.js';
import { buildProviders } from './providerFactory.js';
import * as heartbeat from '../core/heartbeat.js';
import { childLogger } from '../core/logger.js';
import sharp from 'sharp';
import { overlayBox } from '../utils/festivalSpec.js';
import { musicEntries } from '../utils/shortSpec.js';
import { expandMusic } from './musicFolderService.js';

const log = childLogger({ module: 'festival' });

export const MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MAX_COPY = 2000;

const art = (steps, k) => ((steps.find((s) => s.key === k) || {}).artifacts) || {};

/** Put the picture in Drive (shared Anyone with the link). Returns { url, driveId, thumbnailUrl }. */
export async function upload({ tenantId = 'default', buffer, mime = '' }) {
  const ext = IMAGE_TYPES[String(mime).toLowerCase()];
  if (!ext) throw new Error('upload a PNG, JPG or WebP picture');
  if (!buffer || !buffer.length) throw new Error('the picture is empty');
  if (buffer.length > MAX_BYTES) throw new Error('the picture is over 15 MB');
  const providers = await buildProviders(tenantId);
  // The first funnel with a Drive folder holds it; with none, the connected Drive does.
  let folder = '';
  for (const row of await funnels.listByTenant(tenantId)) {
    const f = await funnels.resolve(row).catch(() => null);
    if (f && f.driveFolder) { folder = f.driveFolder; break; }
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const up = await providers.storage.uploadMedia(folder || null, `festival-${stamp}.${ext}`, mime, buffer);
  if (!up || !up.downloadUrl) throw new Error('the picture could not be uploaded to Drive');
  return { url: up.downloadUrl, driveId: up.id || '', thumbnailUrl: up.thumbnailUrl || up.downloadUrl };
}

/** A Drive file's bytes: through the app's Drive access, else its public link. */
async function bytesOf(providers, { driveId = '', url = '' } = {}) {
  if (driveId) {
    try {
      return await providers.storage.download(driveId);
    } catch (err) {
      if (!url) throw err;
    }
  }
  if (!/^https:\/\//.test(url)) throw new Error('the picture is missing');
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`the picture could not be downloaded (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Your background-removed photo on the festival picture, uploaded as a new
 * picture. picture / cutout: { driveId, url }. Returns { url, driveId, thumbnailUrl }.
 */
export async function compose({ tenantId = 'default', picture, cutout, position = 'right', size = 'medium' }) {
  const providers = await buildProviders(tenantId);
  const [pic, cut] = await Promise.all([bytesOf(providers, picture), bytesOf(providers, cutout)]);
  // Turned upright by its EXIF and kept within 2000 px, so the result stays well under the upload limit.
  const { data: upright, info } = await sharp(pic).rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const meta = await sharp(cut).metadata();
  if (!meta.hasAlpha) throw new Error('your photo has no transparent background: upload the background-removed PNG (or WebP)');
  // Trim the empty edges, so the photo stands right on the bottom of the picture.
  const trimmed = await sharp(cut).trim().png().toBuffer({ resolveWithObject: true }).catch(() => sharp(cut).png().toBuffer({ resolveWithObject: true }));
  const box = overlayBox({ W, H, w: trimmed.info.width, h: trimmed.info.height, position, size });
  const layer = await sharp(trimmed.data).resize(box.width, box.height).png().toBuffer();
  const out = await sharp(upright).composite([{ input: layer, left: box.left, top: box.top }]).png().toBuffer();
  // Where your head is, so the subtitles can sit above it (shortSpec subMarginV).
  return { ...(await upload({ tenantId, buffer: out, mime: 'image/png' })), aspect: W / H, photoTop: box.top / H };
}

/** Your music (Settings, with its Drive folders opened) to pick from: [{ url, credit }]. */
export async function musicList(tenantId = 'default') {
  const r = (await buildProviders(tenantId)).resolved || {};
  const expanded = await expandMusic(r.shortMusic || {}).catch(() => r.shortMusic || {});
  return musicEntries(String((expanded && expanded.url) || ''));
}

/** Each funnel with whether it can take a festival post: [{ id, name, active, problem }]. */
export async function funnelReadiness(tenantId = 'default') {
  const providers = await buildProviders(tenantId);
  const rows = await funnels.listByTenant(tenantId);
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    name: row.name,
    active: !!row.active,
    problem: await imageLane.festivalProblem(await funnels.get(row.id), providers, log).catch((err) => err.message),
  })));
}

/**
 * Line up a festival post for the ticked funnels. Funnels that can't take it are
 * skipped with the reason; the videos are made in the background.
 * @returns {{ batchId, started: string[], skipped: {name, reason}[] }}
 */
export async function start({ tenantId = 'default', title = '', copy = '', imageUrl = '', driveId = '', funnelIds = [], postAt = null, autoPost = true, photo = null, music = 'random', musicCredit = '' }) {
  const text = String(copy || '').trim();
  if (!text) throw new Error('write the copy: it is the caption and it is read aloud');
  if (text.length > MAX_COPY) throw new Error(`the copy is over ${MAX_COPY} characters`);
  if (!/^https:\/\//.test(String(imageUrl || ''))) throw new Error('upload the picture first');
  const ids = [...new Set((Array.isArray(funnelIds) ? funnelIds : []).map(String))];
  if (!ids.length) throw new Error('tick at least one funnel');
  const providers = await buildProviders(tenantId);
  const batchId = randomUUID();
  const p = photo || {};
  const placed = Number(p.aspect) > 0 && Number(p.photoTop) > 0 && Number(p.photoTop) < 1;
  const festival = { batchId, imageUrl, driveId: driveId || '', copy: text, title: String(title || '').trim().slice(0, 90), music: /^(none|random|https:\/\/\S+)$/.test(String(music || '')) ? String(music) : 'random', musicCredit: String(musicCredit || '').slice(0, 200), autoPost: !!autoPost, ...(placed ? { aspect: Number(p.aspect), photoTop: Number(p.photoTop) } : {}) };
  const started = [];
  const skipped = [];
  const ready = [];
  for (const id of ids) {
    const row = await funnels.get(Number(id));
    if (!row || String(row.tenant_id) !== String(tenantId)) { skipped.push({ name: `funnel ${id}`, reason: 'not found' }); continue; }
    const problem = await imageLane.festivalProblem(row, providers, log).catch((err) => err.message);
    if (problem) { skipped.push({ name: row.name, reason: problem }); continue; }
    ready.push(row);
    started.push(row.name);
  }
  // One after another, so Railway (when it is the runner) makes one video at a time.
  if (ready.length) {
    heartbeat.during('festival', async () => {
      for (const funnelRow of ready) {
        try {
          await imageLane.prepareFestival({ funnelRow, title: String(title || '').trim() || 'Festival post', festival, postAt, log: log.child({ funnel: funnelRow.name }) });
        } catch (err) {
          log.warn({ funnel: funnelRow.name, err: err.message }, 'festival post not made for this funnel');
        }
      }
    }).catch((err) => log.error({ err: err.message }, 'festival run failed'));
  }
  log.info({ batchId, started: started.length, skipped: skipped.length, postAt: postAt ? postAt.toISOString() : 'now', autoPost: !!autoPost }, 'festival post started');
  return { batchId, started, skipped };
}

/** One festival instance as the page shows it. */
export function viewOf(row) {
  const steps = instanceService.parseSteps(row);
  const img = art(steps, 'images');
  const render = img.render || {};
  const vid = (render.videoIds || {}).portrait;
  const videoUrl = vid ? `https://drive.google.com/file/d/${vid}/view` : ((render.videos || {}).portrait || '');
  return {
    id: row.id,
    batchId: row.source_ref || '',
    funnelName: row.funnel_name || '',
    title: row.title || '',
    status: row.status,
    note: row.note || '',
    scheduledFor: row.scheduled_for || null,
    postedAt: row.posted_at || null,
    createdAt: row.created_at,
    approvalId: img.approvalId || '',
    videoUrl,
    seconds: render.seconds || null,
    musicCredit: render.musicCredit || '',
    imageUrl: (img.festival || {}).imageUrl || '',
    thumbUrl: (img.festival || {}).driveId ? `https://drive.google.com/thumbnail?id=${img.festival.driveId}&sz=w400` : ((img.festival || {}).imageUrl || ''),
    copy: (img.festival || {}).copy || '',
    autoPost: !!(img.festival || {}).autoPost,
  };
}

/** Festival posts grouped by batch, newest batch first: [{ batchId, title, copy, thumbUrl, createdAt, rows }]. */
export async function batches(tenantId = 'default') {
  const rows = (await instanceRepo.festivalRows(tenantId)).map(viewOf);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.batchId)) out.set(r.batchId, { batchId: r.batchId, title: r.title, copy: r.copy, thumbUrl: r.thumbUrl, createdAt: r.createdAt, rows: [] });
    out.get(r.batchId).rows.push(r);
  }
  for (const b of out.values()) b.rows.sort((a, z) => a.funnelName.localeCompare(z.funnelName));
  return [...out.values()];
}

async function festivalRow(tenantId, id) {
  const row = await instanceRepo.get(id);
  if (!row || row.source_type !== 'festival' || String(row.tenant_id) !== String(tenantId)) throw new Error('festival post not found');
  return row;
}

/** Approve one festival post that is waiting (same as the email's Approve). */
export async function approve({ tenantId = 'default', id }) {
  const v = viewOf(await festivalRow(tenantId, id));
  if (v.status !== 'image_review' || !v.approvalId) throw new Error('this one is not waiting for approval');
  const r = await approvalService.approveById(v.approvalId);
  if (!r.ok) throw new Error('already approved');
  return { ok: true };
}

/** Approve every waiting post of a batch. Returns how many were approved. */
export async function approveAll({ tenantId = 'default', batchId }) {
  const rows = (await instanceRepo.festivalRows(tenantId)).map(viewOf).filter((r) => r.batchId === batchId && r.status === 'image_review' && r.approvalId);
  let approved = 0;
  for (const r of rows) if ((await approvalService.approveById(r.approvalId).catch(() => ({ ok: false }))).ok) approved += 1;
  return { approved };
}

/** Make a failed festival post again (its picture and copy stay). */
export async function retry({ tenantId = 'default', id }) {
  const row = await festivalRow(tenantId, id);
  if (!(await instanceRepo.transition(row.id, 'failed', 'running'))) throw new Error('only a failed one can be made again');
  heartbeat.during('festival', () => imageLane.retry({ instanceId: row.id, log }))
    .catch(async (err) => {
      log.warn({ err: err.message, instance: row.id }, 'festival retry failed');
      await instanceRepo.setStatus(row.id, 'failed', `Retry: ${err.message}`).catch(() => {});
    });
  return { ok: true };
}

export default { upload, compose, musicList, funnelReadiness, start, viewOf, batches, approve, approveAll, retry, MAX_BYTES, IMAGE_TYPES, MAX_COPY };
