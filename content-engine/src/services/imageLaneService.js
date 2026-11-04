/**
 * Daily router: Lane 3: the image post (fail-safe).
 *
 * Purpose:      When no video lane delivers a funnel's post, line up an image
 *               post from the funnel's sheet as an INSTANCE, so it goes through
 *               the same instance → Post for Me → post check → go-live email
 *               path as every other lane (docs/daily-router-plan.md, Lane 3).
 * Responsibility:
 *               - prepare: pick the next Ready row no open instance holds (the
 *                 sheet is yours: none left is a failure that tells you to
 *                 set rows back to Ready), create the instance
 *                 (source_type 'sheet', source_ref = the row's key), generate
 *                 the image, send the approval email.
 *               - approve: sheet row → Approved; ONE Post for Me post to all
 *                 the funnel's accounts at scheduled_for, or at once if that
 *                 has passed (D2); first comment + webhook; instance → scheduled.
 *               - rework: regenerate the image with the note, re-send approval.
 *               - onPosted: the post check found it live → sheet row Posted +
 *                 the Post for Me post id.
 * Dependencies: funnelPosterService (sheet tab, image generation, approval
 *               email, sheet writes, capture/IG extras), approvalService,
 *               instanceService/instanceRepository, providerFactory,
 *               publishProvider, firstCommentService, utils/{routerSpec,
 *               postCompose,instanceSpec,pricing,time}, httpClient.
 *
 * Instance statuses: running (image being made) → image_review (approval email
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
import { costImages } from '../utils/pricing.js';
import { formatIst } from '../utils/time.js';
import {
  IMAGE_REVIEW, PFM_COL, LINKS_COL, SHEET_STATUS,
  CELL_NEWLINE, postedLinks, imageAccounts,
  readyRows, pickReadyRow, sheetStock, sheetEmptyText, htmlToText, landingUrls, postAtFor,
} from '../utils/routerSpec.js';
import { childLogger } from '../core/logger.js';

export const KIND = 'image_post';

const baseLog = childLogger({ module: 'imageLane' });

/** A reason the lane could not line up a post (shown on router_days.reason). */
export class LaneError extends Error {}

const recipient = (f, providers) => f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
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
 * Generate the image for an instance, save it on the instance and send the
 * approval email. Leaves the instance at image_review.
 */
async function renderAndSend({ instanceId, f, providers, fields, sheet, note = '', log }) {
  const inst = await instanceRepo.get(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  const { full, short } = composeCaptions(fields, { ctaLink: f.ctaLink, audiencePrefix: f.audiencePrefix });
  const prompt = composePrompt(fields, note);
  await stepLog.start(instanceId, 'images');
  let upload;
  try {
    const image = await poster.generate(providers, prompt, f.imageSize, f.imageKey);
    upload = await providers.storage.uploadPng(f.driveFolder, `${poster.slug(f.name)}-${poster.slug(sheet.key)}-r${inst.round || 1}.png`, image);
    if (!upload || !upload.downloadUrl) throw new Error('the image could not be uploaded to Drive (is a Drive folder set on the funnel?)');
  } catch (err) {
    await stepLog.fail(instanceId, 'images');
    throw err;
  }
  await stepLog.end(instanceId, 'images');

  const { id: approvalId, reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: { instanceId, funnelId: f.id, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl, captionFull: full, captionShort: short },
  });

  let steps = instanceService.parseSteps(inst);
  for (const k of ['animate', 'voiceover', 'transcript', 'stitch']) steps = patchStep(steps, k, { status: 'skipped' });
  steps = patchStep(steps, 'script', { status: 'done', artifacts: { text: short || full, copy: { title: fields.headline || '', description: full }, captionFull: full, captionShort: short } });
  steps = patchStep(steps, 'images', {
    status: 'done',
    finishedAt: new Date().toISOString(),
    artifacts: {
      image: { url: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl, driveId: upload.id || null },
      prompt, note: note || '', row: fields, sheet, approvalId,
    },
  });
  // Real cost when OpenAI made it (Gemini has no per-image price table here).
  if (providers.resolved?.openai?.apiKey) {
    steps = addCostToSteps(steps, 'images', { ...costImages({ count: 1, size: f.imageSize }), at: new Date().toISOString() });
  }
  await instanceRepo.saveSteps(instanceId, steps, sumInstanceCost(steps));
  await instanceRepo.setStatus(instanceId, IMAGE_REVIEW);

  // It waits on the Library's Approve either way, so an email problem fails nothing.
  const to = recipient(f, providers);
  if (!to) {
    await stepLog.start(instanceId, 'review_image', { email: 'none' });
    return log.warn({ instance: instanceId }, 'no approval email address: approve it from the Library');
  }
  const when = inst.scheduled_for ? `${formatIst(inst.scheduled_for)} IST` : '';
  try {
    await providers.mail.send({
      to,
      subject: `${note ? 'Reworked' : 'Approve'} ${f.name} image post${when ? ` for ${when}` : ''}`,
      html: poster.approvalEmail(f.name, upload.thumbnailUrl, full, short, reviewUrl, when),
    });
    await stepLog.start(instanceId, 'review_image', { email: 'sent' });
    log.info({ instance: instanceId, row: sheet.key, round: inst.round }, 'image approval email sent');
  } catch (err) {
    await stepLog.start(instanceId, 'review_image', { email: 'failed' });
    log.warn({ err: err.message, instance: instanceId }, 'image approval email failed: approve it from the Library');
  }
  return null;
}

/** ↻ Retry a failed image post on the same instance: its sheet row again, back to approval. */
export async function retry({ instanceId, log = baseLog }) {
  const row = await instanceRepo.get(instanceId);
  const funnelRow = row && row.funnel_id ? await funnels.get(row.funnel_id) : null;
  if (!funnelRow) throw new LaneError('funnel not found');
  const f = await funnels.resolve(funnelRow);
  const providers = await buildProviders(f.tenantId);
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
  if (!imageAccounts(f.accounts, f.accountMap).length) throw new LaneError('only YouTube is ticked on this funnel, and YouTube takes no image posts');
  const providers = await buildProviders(f.tenantId);
  const tab = await poster.tabFor(providers.sheets, f);
  const rows = await providers.sheets.readTab(f.sheetId, tab, { fresh: true });
  if (!rows.length) throw new LaneError('the content sheet is empty (no header row)');
  if (!extractRow(rows[0], []).hasSchema) throw new LaneError('the content sheet needs a Status and an image prompt column');

  const open = await instanceRepo.openSheetRefs(f.id, f.tenantId);
  const pick = pickReadyRow(rows, open);
  if (!pick) throw new LaneError(sheetEmptyText(sheetStock(rows)));

  const inst = await instanceService.createForFunnel({
    tenantId: f.tenantId,
    funnel: funnelRow,
    title: `${pick.fields.headline || 'Image post'} · ${formatIst(scheduledFor, { withTime: false })}`,
    scheduledFor: scheduledFor.toJSDate(),
    status: 'running',
    sourceType: 'sheet',
    sourceRef: pick.key,
  });
  const sheet = { tab, matchColName: pick.fields.matchColName, key: pick.key, rowNumber: pick.rowNumber };
  try {
    await renderAndSend({ instanceId: inst.id, f, providers, fields: pick.fields, sheet, log });
  } catch (err) {
    await instanceRepo.setStatus(inst.id, 'failed', `Image lane: ${err.message}`).catch(() => {});
    throw err;
  }
  return inst;
}

/** The sheet row an image instance came from (for status writes). */
async function sheetFor(row) {
  const funnel = row.funnel_id ? await funnels.get(row.funnel_id) : null;
  if (!funnel) return null;
  const f = await funnels.resolve(funnel);
  const providers = await buildProviders(f.tenantId);
  const steps = instanceService.parseSteps(row);
  const sheet = art(steps, 'images').sheet || {};
  const tab = sheet.tab || (await poster.tabFor(providers.sheets, f));
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
  await poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, status: SHEET_STATUS.approved }, log);

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
  let ref = null;
  try {
    if (!accounts.length) throw new Error('no Post for Me accounts ticked on this funnel');
    const result = await publish.createPost({ accountIds: accounts, scheduledAt: postAt || undefined, ...req });
    ref = result && result.id ? result.id : null;
    if (!ref) throw new Error('Post for Me did not return a post id');
  } catch (err) {
    log.error({ err: err.message }, 'image post could not be created');
    await stepLog.fail(row.id, 'publish');
    steps = patchStep(steps, 'publish', { status: 'failed', error: err.message });
    await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
    await instanceRepo.setStatus(row.id, 'failed', `Post for Me: ${err.message}`);
    await poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, status: SHEET_STATUS.ready }, log);
    const to = recipient(f, providers);
    if (to) {
      await providers.mail.send({
        to,
        subject: `🔴 ${f.name} image post not scheduled`,
        html: `<p>Post for Me refused the approved ${f.name} image post: ${String(err.message).replace(/[&<>]/g, '')}</p><p>The sheet row is Ready again.</p>`,
      }).catch(() => {});
    }
    return null;
  }

  // The link goes in each channel's first comment once the post is live; the
  // webhook is what wakes a sleeping app when it goes live.
  await firstComment.queue({ tenantId: f.tenantId, postformePostId: ref, link: f.ctaLink, scheduledAt: postAt });
  await firstComment.ensureWebhook(f.tenantId, publish).catch(() => false);
  const fields = img.row || {};
  await poster.armPostExtras({ f, p: { dmKeyword: fields.dmKeyword, dmText: fields.dmText, dmLink: fields.dmLink, matchKey: sheet.key }, ref, accounts, log });

  const channels = accounts.map((id) => ({ id, platform: (accountMap[id] || {}).platform || '', name: (accountMap[id] || {}).account_name || id, state: 'waiting' }));
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: [ref], caption: req.caption, channels, request: req } });
  await instanceRepo.saveSteps(row.id, steps, sumInstanceCost(steps));
  await stepLog.end(row.id, 'publish');
  await instanceRepo.markScheduled(row.id, { postRefs: [ref], scheduledFor: postAt ? new Date(postAt) : null, postNow: !postAt });
  await poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, extra: { [PFM_COL]: ref } }, log);
  await setApprovalStatus(approval.id, 'published');
  log.info({ ref, postAt: postAt || 'now', accounts: accounts.length }, 'image post handed to Post for Me');
  return ref;
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

export default { KIND, LaneError, landingText, prepare, retry, approve, rework, onPosted };
