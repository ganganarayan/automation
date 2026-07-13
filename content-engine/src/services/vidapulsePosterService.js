/**
 * VidaPulse daily image poster.
 *
 * Purpose:      Same skeleton as the Gita poster with VidaPulse differences:
 *               a brand-strip composite instead of a drawn band, a fixed
 *               audience prefix, no-LLM rework (append the note), publish to the
 *               VidaPulse accounts at 10:00 IST.
 * Responsibility: runDaily / publish / rework (see gitaPosterService for the
 *               shared shape).
 * Dependencies: providers, imageComposer, caption/scheduling utils, prompts,
 *               tenantSettings, approvals.
 */
import { DateTime } from 'luxon';
import { buildProviders } from './providerFactory.js';
import * as approvalService from './approvalService.js';
import { setStatus } from '../repositories/approvalRepository.js';
import { vidapulseStrip } from './imageComposer.js';
import { humanizeCaption } from '../utils/caption.js';
import { vidapulseImageScheduledAt } from '../utils/scheduling.js';
import { buildVidapulseImagePrompt } from './prompts.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';

const KIND = 'vidapulse_image';
const SHEET_TAB = 'Sheet1';
const AUDIENCE_PREFIX =
  'Coaches, trainers, consultants, B2B or B2C product/service video marketers:';

async function nextReadyRow(providers, resolved) {
  const rows = await providers.sheets.readTab(resolved.sheets.vidapulse, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  for (const r of rows.slice(1)) {
    if (String(r[col('status')] ?? '').trim().toLowerCase() === 'ready') {
      return { day: r[col('day')], image_prompt: r[col('image_prompt')] || '', caption: r[col('caption')] || '' };
    }
  }
  return null;
}

async function generate(providers, resolved, row, note) {
  const prompt = buildVidapulseImagePrompt(note ? `${row.image_prompt}. Revision requested: ${note}` : row.image_prompt);
  const raw = await providers.llm.generateImage({ prompt, size: '1024x1024' });
  let strip = null;
  if (resolved.drive.stripFile) strip = await providers.storage.download(resolved.drive.stripFile);
  const composited = strip && strip.length ? await vidapulseStrip(raw, strip) : raw;
  return composited;
}

export async function runDaily({ tenantId = 'default' }) {
  const log = childLogger({ module: 'vidapulseImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  if (!resolved.sheets.vidapulse) {
    log.warn('VIDAPULSE_SHEET_ID not configured; skipping');
    return;
  }
  const row = await nextReadyRow(providers, resolved);
  if (!row) {
    log.info('no Ready VidaPulse row');
    return;
  }

  const composited = await generate(providers, resolved, row);
  const upload = await providers.storage.uploadPng(resolved.drive.gitaFolder, `vidapulse-day-${row.day}.png`, composited);
  const caption = humanizeCaption(row.caption, AUDIENCE_PREFIX);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: KIND,
    payload: { day: row.day, base_prompt: row.image_prompt, caption, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });

  await providers.mail.send({
    to: resolved.emails.approvalVidapulse,
    subject: `Approve VidaPulse post — day ${row.day}`,
    html: emailHtml(upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'vidapulse approval email sent');
}

export async function publish(approval) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'vidapulseImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};
  const accounts = resolved.postforme.vidapulseAccounts || [];
  if (!accounts.length) {
    log.warn('no PFM VidaPulse accounts configured; cannot publish');
    return;
  }
  const scheduledAt = vidapulseImageScheduledAt(DateTime.now().setZone(settings.tz)).toISO();
  await providers.publish.createPost({ accountIds: accounts, caption: p.caption, mediaUrl: p.mediaUrl, scheduledAt });

  try {
    const rowNumber = await providers.sheets.findRowIndex(resolved.sheets.vidapulse, SHEET_TAB, 'day', p.day);
    if (rowNumber > 0) {
      const rows = await providers.sheets.readTab(resolved.sheets.vidapulse, SHEET_TAB, { fresh: true });
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const statusCol = colLetter(header.indexOf('status'));
      if (statusCol) await providers.sheets.updateCells(resolved.sheets.vidapulse, `${SHEET_TAB}!${statusCol}${rowNumber}`, [['Posted']]);
    }
  } catch (err) {
    log.warn({ err: err.message }, 'failed to mark VidaPulse sheet Posted');
  }

  await setStatus(approval.id, 'published');
  log.info({ day: p.day, accounts: accounts.length }, 'vidapulse post published');
}

export async function rework(approval, note) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'vidapulseImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};
  const row = { day: p.day, image_prompt: p.base_prompt, caption: p.caption };

  const composited = await generate(providers, resolved, row, note);
  const upload = await providers.storage.uploadPng(resolved.drive.gitaFolder, `vidapulse-day-${row.day}-rework.png`, composited);
  const caption = humanizeCaption(row.caption, AUDIENCE_PREFIX);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: KIND,
    payload: { day: row.day, base_prompt: row.image_prompt, caption, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });
  await providers.mail.send({
    to: resolved.emails.approvalVidapulse,
    subject: `Reworked VidaPulse post — day ${row.day}`,
    html: emailHtml(upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'vidapulse rework email sent');
}

function emailHtml(thumbnailUrl, caption, reviewUrl) {
  return `<div style="font-family:system-ui">
    <p>New VidaPulse post ready for review:</p>
    ${thumbnailUrl ? `<img src="${thumbnailUrl}" style="max-width:420px;border-radius:8px">` : ''}
    <pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(caption)}</pre>
    <p><a href="${reviewUrl}" style="background:#0a7d32;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review &amp; Approve</a></p>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function colLetter(index0) {
  if (index0 < 0) return null;
  let n = index0;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export { KIND };
export default { runDaily, publish, rework, KIND };
