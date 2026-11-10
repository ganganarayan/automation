/**
 * Funnel poster (generalized: replicates the n8n daily posters).
 *
 * Purpose:      Produce, approve, and publish a daily image post for ANY funnel,
 *               driven entirely by that funnel's own configuration. One template
 *               covers Gita, VidaPulse, Corporate and Divine Leads, you just
 *               create a funnel per brand.
 * Responsibility:
 *               - runFunnel(funnel): next Ready row → compose prompt/captions →
 *                 generate image (funnel image size) → upload → approval email.
 *               - publish(approval): ONE Post-for-Me call to the funnel's
 *                 accounts, with per-platform captions (LinkedIn full / others
 *                 short) when the sheet provides both, at the funnel's publish
 *                 time; fire the IG webhook; mark the sheet Posted.
 *               - rework(approval, note): regenerate with the reviewer note.
 *               - Shared with the daily router's image lane (imageLaneService):
 *                 tabFor, generate, armPostExtras, markSheetRow, approvalEmail.
 * Dependencies: funnelsRepository, providerFactory, publishProvider, caption/
 *               scheduling utils, httpClient, approvals.
 *
 * Recognized sheet columns (case-insensitive; only image_prompt + status are
 * required): a match key (post #, day, or id), image prompt, caption, caption
 * full (LinkedIn long), caption short, headline, subhead, hashtags, locked text
 * specs, audience, status.
 */
import { DateTime } from 'luxon';
import * as funnels from '../repositories/funnelsRepository.js';
import { buildProviders } from './providerFactory.js';
import { meter } from './usageMeter.js';
import { costImages } from '../utils/pricing.js';
import * as approvalService from './approvalService.js';
import { setStatus } from '../repositories/approvalRepository.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import * as captureRules from './captureRules.js';
import * as firstComment from './firstCommentService.js';
import { extractRow, composePrompt, composeCaptions, buildPlatformConfigs } from '../utils/postCompose.js';
import { publishAtIst } from '../utils/scheduling.js';
import { targetPostAt, postDateKey } from '../utils/videoSchedule.js';
import { videoOnDate } from '../repositories/instanceRepository.js';
import { request } from '../core/httpClient.js';
import { planHeader, colIndex, colLetter, postedRowPlan } from '../utils/routerSpec.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';
import { fitImage } from '../providers/imageFit.js';

const KIND = 'funnel_image';
const DEFAULT_TAB = 'Sheet1';

/**
 * Resolve the sheet tab for a funnel: its configured tab name, else the first
 * (leftmost) tab of the spreadsheet. Returned ready for A1 notation, names with
 * spaces/special chars are single-quoted so `${tab}!A1` and bare-title ranges work.
 */
export async function tabFor(sheets, f) {
  let title = f.sheetTab;
  if (!title) {
    try {
      title = await sheets.firstTabTitle(f.sheetId);
    } catch {
      title = DEFAULT_TAB;
    }
  }
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${String(title).replace(/'/g, "''")}'`;
}

/** Read the first Ready row and extract the recognized fields. */
async function nextReadyRow(sheets, sheetId, tab) {
  const rows = await sheets.readTab(sheetId, tab, { fresh: true });
  if (rows.length < 2) return null;
  for (const r of rows.slice(1)) {
    const fields = extractRow(rows[0], r);
    if (fields.hasSchema && fields.isReady) return fields;
  }
  return null;
}

/**
 * Generate the post image with whichever AI key the tenant configured: OpenAI
 * when present (honors the image size), otherwise Gemini. If neither is set the
 * OpenAI path throws a clear "not configured" error.
 */
export async function generate(providers, prompt, size, imageKey = '') {
  const r = providers.resolved || {};
  const buf = (!r.openai?.apiKey && r.gemini?.apiKey)
    ? await providers.llm.generateImageGemini({ prompt })
    : await providers.llm.generateImage({ prompt, size });
  // 9:16 / 16:9 come out a little taller / wider: crop to the funnel's aspect.
  return fitImage(buf, imageKey, 'square');
}

/** Generation + approval for one funnel. */
export async function runFunnel(funnelRow) {
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  if (!f.sheetId) {
    log.warn('funnel has no content sheet; skipping');
    return;
  }
  // Videos first: by default the sheet image only goes out on a day with no
  // video scheduled, so posting never gaps when the video runway runs dry.
  const cfg = await funnels.getConfig(funnelRow.id).catch(() => ({}));
  if ((cfg.image_when || 'no_video') === 'no_video') {
    const day = postDateKey(targetPostAt({ publishTime: f.publishTime }));
    if (await videoOnDate(f.id, day, f.tenantId).catch(() => false)) {
      log.info({ day }, 'a video is scheduled that day; sheet image skipped');
      return;
    }
  }
  const providers = await buildProviders(f.tenantId);
  const tab = await tabFor(providers.sheets, f);
  const row = await nextReadyRow(providers.sheets, f.sheetId, tab);
  if (!row) {
    log.info({ tab }, 'no Ready row');
    return;
  }

  const image = await generate(providers, composePrompt(row), f.imageSize, f.imageKey);
  const gem = !providers.resolved?.openai?.apiKey && providers.resolved?.gemini?.apiKey;
  meter(providers, gem ? { ...costImages({ count: 1, model: 'gemini' }), provider: 'gemini' } : costImages({ count: 1, size: f.imageSize }), 'funnel poster');
  const upload = await providers.storage.uploadPng(f.driveFolder, `${slug(f.name)}-${row.matchKey || Date.now()}.png`, image);
  const { full, short } = composeCaptions(row, { ctaLink: f.ctaLink, audiencePrefix: f.audiencePrefix });

  const { reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: {
      funnelId: f.id,
      matchColName: row.matchColName,
      matchKey: row.matchKey,
      basePrompt: row.imagePrompt,
      captionFull: full,
      captionShort: short,
      mediaUrl: upload.downloadUrl,
      thumbnailUrl: upload.thumbnailUrl,
      dmKeyword: row.dmKeyword,
      dmText: row.dmText,
      dmLink: row.dmLink,
    },
  });

  await providers.mail.send({
    to: f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita,
    subject: `Approve ${f.name} post${row.matchKey ? ` (${row.matchKey})` : ''}`,
    html: approvalEmail(f.name, upload.thumbnailUrl, full, short, reviewUrl),
  });
  log.info({ match: row.matchKey }, 'approval email sent');
}

/** Publish after approval: one Post-for-Me call. */
export async function publish(approval) {
  const p = approval.payload || {};
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow) return;
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  const providers = await buildProviders(f.tenantId);
  // Post for Me key is central (API Keys page); the funnel only picks accounts.
  const publisher = createPostForMeProvider({ apiKey: providers.resolved.postformeKey, scope: providers.resolved.postformeScope }, log);

  const accounts = f.accounts || [];
  if (!accounts.length) {
    log.warn('funnel has no Post for Me accounts; cannot publish');
    return;
  }

  const scheduledAt = publishAtIst(f.publishTime, DateTime.now().setZone(settings.tz)).toISO();
  // LinkedIn gets the full caption, other platforms the short one (when distinct).
  const platformConfigurations = buildPlatformConfigs(p.captionFull, p.captionShort);
  const result = await publisher.createPost({
    accountIds: accounts,
    caption: p.captionShort || p.captionFull,
    mediaUrl: p.mediaUrl,
    scheduledAt,
    platformConfigurations,
  });

  const ref = result && result.id ? result.id : null;
  // The link goes in each channel's first comment once the post is live.
  await firstComment.queue({ tenantId: f.tenantId, postformePostId: ref, link: f.ctaLink, scheduledAt });
  await armPostExtras({ f, p, ref, accounts, log });

  await markSheetPosted(providers.sheets, f.sheetId, await tabFor(providers.sheets, f), p.matchColName, p.matchKey, log);
  await setStatus(approval.id, 'published');
  log.info({ match: p.matchKey, accounts: accounts.length, perPlatform: !!platformConfigurations }, 'published');
}

/**
 * After a funnel post is created: arm comment-to-DM (the sheet row's
 * keyword/dm_text/dm_link, else the funnel defaults) and fire the optional
 * IG-comment webhook. Best-effort; never fails the post.
 */
export async function armPostExtras({ f, p, ref, accounts, log }) {
  const keyword = (p.dmKeyword || f.captureKeyword || '').trim();
  if (ref && keyword) {
    await captureRules.createForPublish({
      tenantId: f.tenantId, funnelId: f.id, lane: f.name,
      platforms: captureRules.dmPlatforms(accounts, f.accountMap),
      postformePostId: ref,
      keyword,
      dmText: p.dmText || f.captureDmText,
      dmLink: p.dmLink || f.captureDmLink || f.ctaLink,
      publicReplyVariants: f.capturePublicReplies,
      requireFollow: f.captureRequireFollow, followupText: f.captureFollowupText,
      notFollowingText: f.captureNotFollowingText,
      log,
    }).catch((err) => log.warn({ err: err.message }, 'capture rule create failed (posted anyway)'));
  }

  // Optional IG-comment automation webhook (best-effort).
  if (f.igWebhookUrl) {
    request(f.igWebhookUrl, { method: 'POST', body: { funnel: f.name, match: p.matchKey }, label: 'ig.webhook', log, retries: 0 }).catch(() => {});
  }
}

/** Rework: regenerate with the reviewer note. */
export async function rework(approval, note) {
  const p = approval.payload || {};
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow) return;
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  const providers = await buildProviders(f.tenantId);

  const image = await generate(providers, composePrompt({ imagePrompt: p.basePrompt }, note), f.imageSize, f.imageKey);
  const upload = await providers.storage.uploadPng(f.driveFolder, `${slug(f.name)}-${p.matchKey || Date.now()}-rework.png`, image);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: { ...p, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });
  await providers.mail.send({
    to: f.approvalEmail || providers.resolved?.emails?.notify || providers.resolved?.emails?.approvalGita,
    subject: `Reworked ${f.name} post${p.matchKey ? ` (${p.matchKey})` : ''}`,
    html: approvalEmail(f.name, upload.thumbnailUrl, p.captionFull, p.captionShort, reviewUrl),
  });
  log.info({ match: p.matchKey }, 'rework email sent');
}

/** Run every active funnel (used by the manual trigger). */
export async function runAllActive() {
  const active = await funnels.listActive();
  for (const funnel of active) {
    try {
      await runFunnel(funnel);
    } catch (err) {
      childLogger({ module: 'funnelPoster', tenant_id: funnel.tenant_id, funnel: funnel.name }).error({ err: err.message }, 'funnel run failed');
    }
  }
}

// ---- helpers ---------------------------------------------------------------

async function markSheetPosted(sheets, sheetId, tab, matchColName, matchKey, log) {
  await markSheetRow(sheets, sheetId, tab, { matchColName: matchColName || 'day', matchKey, status: 'Posted' }, log);
}

/**
 * Write a sheet row's status and any extra columns ({ header: value }). The
 * row is found by its match column + key, or by `rowNumber` (1-based) when the
 * sheet has no key column (key "row:N"). Missing extra header cells are created
 * at the end of row 1. Best-effort: returns false (and logs) instead of throwing.
 */
export async function markSheetRow(sheets, sheetId, tab, { matchColName = null, matchKey = '', rowNumber = 0, status = '', extra = {} } = {}, log) {
  try {
    const rows = await sheets.readTab(sheetId, tab, { fresh: true });
    if (!rows.length) return false;
    const plan = planHeader(rows[0], Object.keys(extra));
    for (const a of plan.added) await sheets.updateCells(sheetId, `${tab}!${colLetter(a.index)}1`, [[a.name]]);
    const header = plan.header;
    const key = String(matchKey ?? '').trim();
    let n = 0;
    if (key.startsWith('row:')) n = parseInt(key.slice(4), 10) || 0;
    else if (matchColName && key) {
      const ci = colIndex(header, matchColName);
      for (let i = 1; ci !== -1 && i < rows.length; i += 1) {
        if (String((rows[i] || [])[ci] ?? '').trim() === key) { n = i + 1; break; }
      }
    } else n = rowNumber;
    if (n <= 1) return false;
    const cells = { ...(status ? { status } : {}), ...extra };
    for (const [name, value] of Object.entries(cells)) {
      const ci = colIndex(header, name);
      if (ci !== -1) await sheets.updateCells(sheetId, `${tab}!${colLetter(ci)}${n}`, [[String(value ?? '')]]);
    }
    return true;
  } catch (err) {
    log.warn({ err: err.message }, `failed to mark sheet row${status ? ` ${status}` : ''}`);
    return false;
  }
}

/**
 * Append one "already posted" row to a funnel's sheet, for a post that never
 * had a row of its own: the video lanes draw from Drive and from the AI
 * pipeline, not from the sheet. The row carries Posted, a continued key, the
 * title, the posted time (IST) and the live links, one per line in the cell.
 * Missing columns are created at the end of row 1, and a row this post already
 * has is filled in rather than written twice (routerSpec.postedRowPlan).
 * Best-effort: returns false (and logs) instead of throwing, so a sheet
 * problem never fails a post that is already live.
 */
export async function appendPostedRow(sheets, sheetId, tab, fields = {}, log) {
  try {
    const rows = await sheets.readTab(sheetId, tab, { fresh: true });
    const plan = postedRowPlan(rows, fields);
    if (!plan.header.length) return false; // no header row: not a content sheet
    if (plan.rowNumber) {
      const { status, ...extra } = plan.cells;
      return markSheetRow(sheets, sheetId, tab, { matchKey: `row:${plan.rowNumber}`, status, extra }, log);
    }
    for (const a of plan.added) await sheets.updateCells(sheetId, `${tab}!${colLetter(a.index)}1`, [[a.name]]);
    await sheets.appendRow(sheetId, tab, plan.values);
    return true;
  } catch (err) {
    log.warn({ err: err.message }, 'failed to append the posted row');
    return false;
  }
}

/** The approval email body (image, caption(s), optional "posts at" line, the review link). */
export function approvalEmail(funnelName, thumbnailUrl, full, short, reviewUrl, scheduledText = '') {
  const distinct = full && short && full !== short;
  const caps = distinct
    ? `<p><b>LinkedIn (full):</b></p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(full)}</pre>
       <p><b>Other channels (short):</b></p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(short)}</pre>`
    : `<pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(short || full)}</pre>`;
  return `<div style="font-family:system-ui">
    <p>New ${escapeHtml(funnelName)} post ready for review:</p>
    ${thumbnailUrl ? `<img src="${thumbnailUrl}" style="max-width:420px;border-radius:8px">` : ''}
    ${caps}
    ${scheduledText ? `<p><b>Posts:</b> ${escapeHtml(scheduledText)} on all of this funnel's channels. Approved after that time, it posts at once.</p>` : ''}
    <p><a href="${reviewUrl}" style="background:#0a7d32;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review &amp; Approve</a></p>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
export function slug(s) {
  return String(s || 'funnel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export { KIND };
export default { runFunnel, publish, rework, runAllActive, KIND };
