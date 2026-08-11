/**
 * Funnel poster (generalized — replicates the n8n daily posters).
 *
 * Purpose:      Produce, approve, and publish a daily image post for ANY funnel,
 *               driven entirely by that funnel's own configuration. One template
 *               covers Gita, VidaPulse, Corporate and Divine Leads — you just
 *               create a funnel per brand.
 * Responsibility:
 *               - runFunnel(funnel): next Ready row → compose prompt/captions →
 *                 generate image (funnel image size) → upload → approval email.
 *               - publish(approval): ONE Post-for-Me call to the funnel's
 *                 accounts, with per-platform captions (LinkedIn full / others
 *                 short) when the sheet provides both, at the funnel's publish
 *                 time; fire the IG webhook; mark the sheet Posted.
 *               - rework(approval, note): regenerate with the reviewer note.
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
import * as approvalService from './approvalService.js';
import { setStatus } from '../repositories/approvalRepository.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { extractRow, composePrompt, composeCaptions, buildPlatformConfigs } from '../utils/postCompose.js';
import { publishAtIst } from '../utils/scheduling.js';
import { request } from '../core/httpClient.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';

const KIND = 'funnel_image';
const SHEET_TAB = 'Sheet1';

/** Read the first Ready row and extract the recognized fields. */
async function nextReadyRow(sheets, sheetId) {
  const rows = await sheets.readTab(sheetId, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return null;
  for (const r of rows.slice(1)) {
    const fields = extractRow(rows[0], r);
    if (fields.hasSchema && fields.isReady) return fields;
  }
  return null;
}

async function generate(providers, prompt, size) {
  return providers.llm.generateImage({ prompt, size });
}

/** Generation + approval for one funnel. */
export async function runFunnel(funnelRow) {
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  if (!f.sheetId) {
    log.warn('funnel has no content sheet; skipping');
    return;
  }
  const providers = await buildProviders(f.tenantId);
  const row = await nextReadyRow(providers.sheets, f.sheetId);
  if (!row) {
    log.info('no Ready row');
    return;
  }

  const image = await generate(providers, composePrompt(row), f.imageSize);
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
    },
  });

  await providers.mail.send({
    to: f.approvalEmail,
    subject: `Approve ${f.name} post${row.matchKey ? ` (${row.matchKey})` : ''}`,
    html: approvalEmail(f.name, upload.thumbnailUrl, full, short, reviewUrl),
  });
  log.info({ match: row.matchKey }, 'approval email sent');
}

/** Publish after approval — one Post-for-Me call. */
export async function publish(approval) {
  const p = approval.payload || {};
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow) return;
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  const providers = await buildProviders(f.tenantId);
  const publisher = createPostForMeProvider({ apiKey: f.postformeKey || providers.resolved.postformeKey }, log);

  const accounts = f.accounts || [];
  if (!accounts.length) {
    log.warn('funnel has no Post for Me accounts; cannot publish');
    return;
  }

  const scheduledAt = publishAtIst(f.publishTime, DateTime.now().setZone(settings.tz)).toISO();
  // LinkedIn gets the full caption, other platforms the short one (when distinct).
  const platformConfigurations = buildPlatformConfigs(p.captionFull, p.captionShort);
  await publisher.createPost({
    accountIds: accounts,
    caption: p.captionShort || p.captionFull,
    mediaUrl: p.mediaUrl,
    scheduledAt,
    platformConfigurations,
  });

  // Optional IG-comment automation webhook (best-effort).
  if (f.igWebhookUrl) {
    request(f.igWebhookUrl, { method: 'POST', body: { funnel: f.name, match: p.matchKey }, label: 'ig.webhook', log, retries: 0 }).catch(() => {});
  }

  await markSheetPosted(providers.sheets, f.sheetId, p.matchColName, p.matchKey, log);
  await setStatus(approval.id, 'published');
  log.info({ match: p.matchKey, accounts: accounts.length, perPlatform: !!platformConfigurations }, 'published');
}

/** Rework — regenerate with the reviewer note. */
export async function rework(approval, note) {
  const p = approval.payload || {};
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow) return;
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  const providers = await buildProviders(f.tenantId);

  const image = await generate(providers, composePrompt({ imagePrompt: p.basePrompt }, note), f.imageSize);
  const upload = await providers.storage.uploadPng(f.driveFolder, `${slug(f.name)}-${p.matchKey || Date.now()}-rework.png`, image);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: { ...p, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });
  await providers.mail.send({
    to: f.approvalEmail,
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

async function markSheetPosted(sheets, sheetId, matchColName, matchKey, log) {
  try {
    const matchCol = matchColName || 'day';
    const rowNumber = await sheets.findRowIndex(sheetId, SHEET_TAB, matchCol, matchKey);
    if (rowNumber <= 0) return;
    const rows = await sheets.readTab(sheetId, SHEET_TAB, { fresh: true });
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const idx = header.indexOf('status');
    if (idx === -1) return;
    await sheets.updateCells(sheetId, `${SHEET_TAB}!${colLetter(idx)}${rowNumber}`, [['Posted']]);
  } catch (err) {
    log.warn({ err: err.message }, 'failed to mark sheet Posted');
  }
}

function colLetter(index0) {
  let n = index0;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function approvalEmail(funnelName, thumbnailUrl, full, short, reviewUrl) {
  const distinct = full && short && full !== short;
  const caps = distinct
    ? `<p><b>LinkedIn (full):</b></p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(full)}</pre>
       <p><b>Other channels (short):</b></p><pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(short)}</pre>`
    : `<pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(short || full)}</pre>`;
  return `<div style="font-family:system-ui">
    <p>New ${escapeHtml(funnelName)} post ready for review:</p>
    ${thumbnailUrl ? `<img src="${thumbnailUrl}" style="max-width:420px;border-radius:8px">` : ''}
    ${caps}
    <p><a href="${reviewUrl}" style="background:#0a7d32;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review &amp; Approve</a></p>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function slug(s) {
  return String(s || 'funnel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export { KIND };
export default { runFunnel, publish, rework, runAllActive, KIND };
