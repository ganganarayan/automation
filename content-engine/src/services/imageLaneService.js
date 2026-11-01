/**
 * Daily router: Lane 3: the image post (fail-safe).
 *
 * Purpose:      When no video lane delivers a funnel's post, line up an image
 *               post from the funnel's sheet as an INSTANCE, so it goes through
 *               the same instance → Post for Me → post check → go-live email
 *               path as every other lane (docs/daily-router-plan.md, Lane 3).
 * Responsibility:
 *               - prepare: top the sheet up (fewer than 2 Ready rows → 7 new
 *                 rows from the landing page + post history), pick the next
 *                 Ready row no open instance holds, create the instance
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
  IMAGE_REVIEW, REFILL_BELOW, REFILL_COUNT, PFM_COL, SOURCE_COL, SHEET_STATUS,
  readyRows, pickReadyRow, planHeader, colLetter, nextMatchKeys, htmlToText, historyLines,
  instanceHistoryLine, sheetHistory, sheetColumns, refillPrompt, normalizeRefill, rowsForSheet, postAtFor,
} from '../utils/routerSpec.js';
import { childLogger } from '../core/logger.js';

export const KIND = 'image_post';

const baseLog = childLogger({ module: 'imageLane' });

/** A reason the lane could not line up a post (shown on router_days.reason). */
export class LaneError extends Error {}

const recipient = (f, providers) => f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita || '';
const art = (steps, k) => ((steps.find((s) => s.key === k) || {}).artifacts) || {};

/** The funnel's landing page as plain text ('' when unset or unreachable). Lane 2 research uses it too. */
export async function landingText(url, log) {
  if (!url) return '';
  try {
    const res = await request(url, { label: 'landing.page', log, retries: 0, timeoutMs: 15000, headers: { Accept: 'text/html' } });
    return res.ok ? htmlToText(res.text, 6000) : '';
  } catch (err) {
    log.warn({ err: err.message, url }, 'landing page fetch failed (refilling without it)');
    return '';
  }
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
 * Generate the image for an instance, save it on the instance and send the
 * approval email. Leaves the instance at image_review.
 */
async function renderAndSend({ instanceId, f, providers, fields, sheet, note = '', log }) {
  const inst = await instanceRepo.get(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  const { full, short } = composeCaptions(fields, { ctaLink: f.ctaLink, audiencePrefix: f.audiencePrefix });
  const prompt = composePrompt(fields, note);
  const image = await poster.generate(providers, prompt, f.imageSize);
  const upload = await providers.storage.uploadPng(f.driveFolder, `${poster.slug(f.name)}-${poster.slug(sheet.key)}-r${inst.round || 1}.png`, image);
  if (!upload || !upload.downloadUrl) throw new Error('the image could not be uploaded to Drive (is a Drive folder set on the funnel?)');

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

  const to = recipient(f, providers);
  if (!to) throw new LaneError('no email address to send the approval to (set Settings → Emails → Notification)');
  const when = inst.scheduled_for ? `${formatIst(inst.scheduled_for)} IST` : '';
  await providers.mail.send({
    to,
    subject: `${note ? 'Reworked' : 'Approve'} ${f.name} image post${when ? ` for ${when}` : ''}`,
    html: poster.approvalEmail(f.name, upload.thumbnailUrl, full, short, reviewUrl, when),
  });
  log.info({ instance: instanceId, row: sheet.key, round: inst.round }, 'image approval email sent');
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
  const tab = await poster.tabFor(providers.sheets, f);
  let rows = await providers.sheets.readTab(f.sheetId, tab, { fresh: true });
  if (!rows.length) throw new LaneError('the content sheet is empty (no header row)');
  if (!extractRow(rows[0], []).hasSchema) throw new LaneError('the content sheet needs a Status and an image prompt column');

  const open = await instanceRepo.openSheetRefs(f.id, f.tenantId);
  const free = readyRows(rows).filter((r) => !open.includes(r.key));
  if (free.length < REFILL_BELOW) {
    rows = await refill({ f, providers, tab, rows, log }).catch((err) => {
      log.warn({ err: err.message }, 'image sheet refill failed (using what is there)');
      return rows;
    });
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
  const accounts = f.accounts || [];
  const accountMap = f.accountMap || {};
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

/** Post check hook: an image instance is live → its sheet row is Posted + the post id. */
export async function onPosted(row, { refs = [] } = {}) {
  if (!row || row.source_type !== 'sheet') return;
  const ctx = await sheetFor(row);
  if (!ctx) return;
  const ids = (refs.length ? refs : (Array.isArray(row.post_refs) ? row.post_refs : [])).filter(Boolean);
  await poster.markSheetRow(ctx.providers.sheets, ctx.f.sheetId, ctx.tab, {
    matchColName: ctx.sheet.matchColName, matchKey: ctx.sheet.key, rowNumber: ctx.sheet.rowNumber,
    status: SHEET_STATUS.posted, extra: { [PFM_COL]: ids.join(', ') },
  }, baseLog);
}

export default { KIND, LaneError, landingText, prepare, approve, rework, onPosted };
