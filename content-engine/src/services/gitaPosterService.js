/**
 * Gita daily image poster.
 *
 * Purpose:      Produce, get approval for, and publish the daily Gita image post.
 * Responsibility:
 *               - runDaily: pick the next Ready image row, vary the look,
 *                 generate + band-overlay the image, upload to Drive, humanize
 *                 the caption, and email an approval request.
 *               - publish: on approve, publish to the 7 Gita accounts with
 *                 per-platform UTM captions and scheduled_at rules, trigger IG
 *                 comment automation, and mark the sheet row Posted.
 *               - rework: on rework, ask the LLM to revise prompt+caption and
 *                 re-run generation.
 * Dependencies: providers (sheets, llm, storage, publish, mail, http), prompts,
 *               imageComposer, caption/scheduling utils, tenantSettings, approvals.
 */
import { DateTime } from 'luxon';
import { buildProviders } from './providerFactory.js';
import * as approvalService from './approvalService.js';
import { gitaBand } from './imageComposer.js';
import { humanizeCaption, withChannelLink, CHANNELS } from '../utils/caption.js';
import { gitaImageScheduledAt } from '../utils/scheduling.js';
import { GITA_ORIENTATIONS, GITA_REWORK_SYSTEM, buildGitaImagePrompt } from './prompts.js';
import { request } from '../core/httpClient.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';

const KIND = 'gita_image';
const SHEET_TAB = 'Sheet1';

/** Read the first Ready + image row from the Gita sheet. */
async function nextReadyRow(providers, resolved) {
  const rows = await providers.sheets.readTab(resolved.sheets.gita, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const data = rows.slice(1);
  for (const r of data) {
    const status = String(r[col('status')] ?? '').trim().toLowerCase();
    const format = String(r[col('format')] ?? 'image').trim().toLowerCase();
    if (status === 'ready' && (format === 'image' || col('format') === -1)) {
      return {
        day: r[col('day')],
        image_prompt: r[col('image_prompt')] || '',
        caption: r[col('caption')] || '',
        audience: r[col('audience')] || '',
      };
    }
  }
  return null;
}

/** Generate the composited image buffer + resolved prompt for a row. */
async function generate(providers, row, note) {
  const orientation = GITA_ORIENTATIONS[Math.floor(Math.random() * GITA_ORIENTATIONS.length)];
  const prompt = buildGitaImagePrompt(note ? `${row.image_prompt}. ${note}` : row.image_prompt, orientation);
  const raw = await providers.llm.generateImage({ prompt, size: '1024x1024' });
  const composited = await gitaBand(raw, `FOR ${row.audience || 'YOU'}`);
  return { composited, prompt };
}

/** Daily entry point. */
export async function runDaily({ tenantId = 'default' }) {
  const log = childLogger({ module: 'gitaImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  if (!resolved.sheets.gita) {
    log.warn('GITA_SHEET_ID not configured; skipping');
    return;
  }
  const row = await nextReadyRow(providers, resolved);
  if (!row) {
    log.info('no Ready Gita image row');
    return;
  }

  const { composited } = await generate(providers, row);
  const upload = await providers.storage.uploadPng(resolved.drive.gitaFolder, `gita-day-${row.day}.png`, composited);
  const caption = humanizeCaption(row.caption, row.audience);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: KIND,
    payload: {
      day: row.day,
      audience: row.audience,
      base_prompt: row.image_prompt,
      caption,
      mediaUrl: upload.downloadUrl,
      thumbnailUrl: upload.thumbnailUrl,
    },
  });

  await providers.mail.send({
    to: resolved.emails.approvalGita,
    subject: `Approve Gita post — day ${row.day}`,
    html: approvalEmail(upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'gita approval email sent');
}

/** Publish after approval. */
export async function publish(approval) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'gitaImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};
  const accounts = resolved.postforme.gitaAccounts || [];
  if (!accounts.length) {
    log.warn('no PFM Gita accounts configured; cannot publish');
    return;
  }

  const platformOf = (id) => (resolved.postforme.accountMap?.[id]?.platform || 'organic');
  const perAccountCaption = {};
  for (const id of accounts) {
    const platform = CHANNELS.includes(platformOf(id)) ? platformOf(id) : 'organic';
    perAccountCaption[id] = withChannelLink(p.caption, resolved.links.gitaAssessment, platform);
  }

  const scheduledAt = gitaImageScheduledAt(DateTime.now().setZone(settings.tz)).toISO();
  await providers.publish.createPost({
    accountIds: accounts,
    caption: p.caption,
    mediaUrl: p.mediaUrl,
    scheduledAt,
    perAccountCaption,
  });

  // IG comment automation trigger (ignore failures).
  if (resolved.instagram.automationUrl) {
    request(resolved.instagram.automationUrl, {
      method: 'POST',
      headers: { contact_email: resolved.instagram.contactEmail },
      body: { day: p.day },
      label: 'ig.automation',
      log,
      retries: 0,
    }).catch(() => {});
  }

  // Mark the sheet row Posted (match on day).
  try {
    const rowNumber = await providers.sheets.findRowIndex(resolved.sheets.gita, SHEET_TAB, 'day', p.day);
    if (rowNumber > 0) {
      const rows = await providers.sheets.readTab(resolved.sheets.gita, SHEET_TAB, { fresh: true });
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const statusCol = colLetter(header.indexOf('status'));
      const postedCol = colLetter(header.indexOf('posted_at'));
      if (statusCol) await providers.sheets.updateCells(resolved.sheets.gita, `${SHEET_TAB}!${statusCol}${rowNumber}`, [['Posted']]);
      if (postedCol) await providers.sheets.updateCells(resolved.sheets.gita, `${SHEET_TAB}!${postedCol}${rowNumber}`, [[new Date().toISOString()]]);
    }
  } catch (err) {
    log.warn({ err: err.message }, 'failed to mark sheet Posted');
  }

  await markPublished(approval.id);
  log.info({ day: p.day, accounts: accounts.length }, 'gita post published');
}

/** Rework after a change request. */
export async function rework(approval, note) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'gitaImagePoster', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};

  // Ask the LLM for a revised prompt + caption.
  const revised = await providers.llm.generateJson({
    system: GITA_REWORK_SYSTEM,
    user: JSON.stringify({ image_prompt: p.base_prompt, caption: p.caption, note }),
  });
  const row = {
    day: p.day,
    audience: p.audience,
    image_prompt: revised.image_prompt || p.base_prompt,
    caption: revised.caption || p.caption,
  };

  const { composited } = await generate(providers, row);
  const upload = await providers.storage.uploadPng(resolved.drive.gitaFolder, `gita-day-${row.day}-rework.png`, composited);
  const caption = humanizeCaption(row.caption, row.audience);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: KIND,
    payload: {
      day: row.day,
      audience: row.audience,
      base_prompt: row.image_prompt,
      caption,
      mediaUrl: upload.downloadUrl,
      thumbnailUrl: upload.thumbnailUrl,
    },
  });

  await providers.mail.send({
    to: resolved.emails.approvalGita,
    subject: `Reworked Gita post — day ${row.day}`,
    html: approvalEmail(upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'gita rework email sent');
}

// ---- helpers ---------------------------------------------------------------

async function markPublished(id) {
  const { setStatus } = await import('../repositories/approvalRepository.js');
  await setStatus(id, 'published');
}

function approvalEmail(thumbnailUrl, caption, reviewUrl) {
  return `<div style="font-family:system-ui">
    <p>New Gita post ready for review:</p>
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
