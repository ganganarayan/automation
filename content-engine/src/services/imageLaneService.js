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
 * Dependencies: funnelPosterService (sheet tab, image generation, approval
 *               email, sheet writes, capture/IG extras), approvalService,
 *               instanceService/instanceRepository, providerFactory,
 *               publishProvider, firstCommentService, utils/{routerSpec,
 *               postCompose,instanceSpec,pricing,time}, httpClient.
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
import { shortTitle } from '../utils/shortSpec.js';
import { costImages } from '../utils/pricing.js';
import { formatIst } from '../utils/time.js';
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
 * Generate the image for an instance, save it on the instance and send the
 * approval. Leaves the instance at image_review.
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

  const { id: approvalId } = await approvalService.createRequest({
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

  // The daily email carries the approval link; the Library's Approve works too.
  await stepLog.start(instanceId, 'review_image', { email: 'digest' });
  log.info({ instance: instanceId, row: sheet.key, round: inst.round }, 'image post waiting for approval');
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
  const providers = await buildProviders(f.tenantId);
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
  // YouTube takes no images: it gets the picture as a Short, on a post of its own.
  const ytAccounts = (f.accounts || []).filter((id) => !accounts.includes(id));
  const ytConfig = { title: shortTitle(row.title, short || full), caption: full || short };
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
    await poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, status: SHEET_STATUS.ready }, log);
    return null;
  }

  // The link goes in each channel's first comment once the post is live; the
  // webhook is what wakes a sleeping app when it goes live.
  const refs = [ref, shortRef].filter(Boolean);
  for (const made of refs) await firstComment.queue({ tenantId: f.tenantId, postformePostId: made, link: f.ctaLink, scheduledAt: postAt });
  await firstComment.ensureWebhook(f.tenantId, publish).catch(() => false);
  const fields = img.row || {};
  if (ref) await poster.armPostExtras({ f, p: { dmKeyword: fields.dmKeyword, dmText: fields.dmText, dmLink: fields.dmLink, matchKey: sheet.key }, ref, accounts, log });

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
  await poster.markSheetRow(providers.sheets, f.sheetId, tab, { ...where, extra: { [PFM_COL]: refs.join(', ') } }, log);
  await setApprovalStatus(approval.id, 'published');
  log.info({ refs, postAt: postAt || 'now', accounts: accounts.length, shorts: shortRef ? ytAccounts.length : 0 }, 'image post handed to Post for Me');
  return refs[0];
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
