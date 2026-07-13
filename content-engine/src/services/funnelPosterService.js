/**
 * Funnel image poster (generalized, per-funnel).
 *
 * Purpose:      Produce, approve, and publish a daily image post for ANY funnel,
 *               driven entirely by that funnel's own configuration. This replaces
 *               the two hardcoded brand posters (Gita/VidaPulse) — those are now
 *               just funnels with style 'band' and 'strip'.
 * Responsibility:
 *               - runDaily(funnel): next Ready row → generate (style-aware) →
 *                 overlay → upload → approval email.
 *               - publish(approval): publish to the funnel's own Post-for-Me
 *                 accounts at the funnel's publish time, then mark the sheet.
 *               - rework(approval, note): LLM revise + regenerate.
 * Dependencies: funnelsRepository, providerFactory, imageComposer, prompts,
 *               caption/scheduling utils, approvals, publishProvider.
 */
import { DateTime } from 'luxon';
import * as funnels from '../repositories/funnelsRepository.js';
import { buildProviders } from './providerFactory.js';
import * as approvalService from './approvalService.js';
import { setStatus } from '../repositories/approvalRepository.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { gitaBand, vidapulseStrip } from './imageComposer.js';
import { humanizeCaption, withChannelLink, CHANNELS } from '../utils/caption.js';
import { publishAtIst } from '../utils/scheduling.js';
import { GITA_ORIENTATIONS, GITA_REWORK_SYSTEM, buildGitaImagePrompt, buildVidapulseImagePrompt } from './prompts.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';

const KIND = 'funnel_image';
const SHEET_TAB = 'Sheet1';

/** Read the first Ready + image row from a funnel's sheet. */
async function nextReadyRow(sheets, sheetId) {
  const rows = await sheets.readTab(sheetId, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  for (const r of rows.slice(1)) {
    const status = String(r[col('status')] ?? '').trim().toLowerCase();
    const format = col('format') === -1 ? 'image' : String(r[col('format')] ?? 'image').trim().toLowerCase();
    if (status === 'ready' && format === 'image') {
      return { day: r[col('day')], image_prompt: r[col('image_prompt')] || '', caption: r[col('caption')] || '', audience: col('audience') === -1 ? '' : r[col('audience')] || '' };
    }
  }
  return null;
}

/** Style-aware prompt + overlay. */
async function generate(f, providers, row, note) {
  let prompt;
  if (f.style === 'band') {
    const orientation = GITA_ORIENTATIONS[Math.floor(Math.random() * GITA_ORIENTATIONS.length)];
    prompt = buildGitaImagePrompt(note ? `${row.image_prompt}. ${note}` : row.image_prompt, orientation);
  } else if (f.style === 'strip') {
    prompt = buildVidapulseImagePrompt(note ? `${row.image_prompt}. Revision requested: ${note}` : row.image_prompt);
  } else {
    prompt = note ? `${row.image_prompt}. ${note}` : row.image_prompt;
  }

  const raw = await providers.llm.generateImage({ prompt, size: '1024x1024' });
  const audience = row.audience || f.audiencePrefix || '';
  if (f.style === 'band') return gitaBand(raw, `FOR ${(audience || 'YOU').toUpperCase()}`);
  if (f.style === 'strip' && f.stripFile) {
    const strip = await providers.storage.download(f.stripFile);
    return strip && strip.length ? vidapulseStrip(raw, strip) : raw;
  }
  return raw;
}

/** Daily entry point for one funnel. */
export async function runDaily(funnelRow) {
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  if (!f.sheetId) {
    log.warn('funnel has no content sheet configured; skipping');
    return;
  }
  const providers = await buildProviders(f.tenantId);

  const row = await nextReadyRow(providers.sheets, f.sheetId);
  if (!row) {
    log.info('no Ready row');
    return;
  }

  const composited = await generate(f, providers, row);
  const upload = await providers.storage.uploadPng(f.driveFolder, `${slug(f.name)}-day-${row.day}.png`, composited);
  const audience = row.audience || f.audiencePrefix || '';
  const caption = humanizeCaption(row.caption, audience);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: { funnelId: f.id, day: row.day, base_prompt: row.image_prompt, caption, audience, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });

  await providers.mail.send({
    to: f.approvalEmail,
    subject: `Approve ${f.name} post — day ${row.day}`,
    html: approvalEmail(f.name, upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'approval email sent');
}

/** Publish after approval. */
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

  const platformOf = (id) => f.accountMap?.[id]?.platform || 'organic';
  const perAccountCaption = {};
  for (const id of accounts) {
    const platform = CHANNELS.includes(platformOf(id)) ? platformOf(id) : 'organic';
    perAccountCaption[id] = f.ctaLink ? withChannelLink(p.caption, f.ctaLink, platform) : p.caption;
  }

  const scheduledAt = publishAtIst(f.publishTime, DateTime.now().setZone(settings.tz)).toISO();
  await publisher.createPost({ accountIds: accounts, caption: p.caption, mediaUrl: p.mediaUrl, scheduledAt, perAccountCaption });

  await markSheetPosted(providers.sheets, f.sheetId, p.day, log);
  await setStatus(approval.id, 'published');
  log.info({ day: p.day, accounts: accounts.length }, 'published');
}

/** Rework after a change request. */
export async function rework(approval, note) {
  const p = approval.payload || {};
  const funnelRow = await funnels.get(p.funnelId);
  if (!funnelRow) return;
  const f = await funnels.resolve(funnelRow);
  const log = childLogger({ module: 'funnelPoster', tenant_id: f.tenantId, funnel: f.name });
  const providers = await buildProviders(f.tenantId);

  let row = { day: p.day, image_prompt: p.base_prompt, caption: p.caption, audience: p.audience };
  if (f.style === 'band') {
    const revised = await providers.llm.generateJson({
      system: GITA_REWORK_SYSTEM,
      user: JSON.stringify({ image_prompt: p.base_prompt, caption: p.caption, note }),
    });
    row = { ...row, image_prompt: revised.image_prompt || p.base_prompt, caption: revised.caption || p.caption };
  }

  const composited = await generate(f, providers, row, f.style === 'band' ? null : note);
  const upload = await providers.storage.uploadPng(f.driveFolder, `${slug(f.name)}-day-${row.day}-rework.png`, composited);
  const caption = humanizeCaption(row.caption, row.audience || f.audiencePrefix || '');

  const { reviewUrl } = await approvalService.createRequest({
    tenantId: f.tenantId,
    kind: KIND,
    payload: { funnelId: f.id, day: row.day, base_prompt: row.image_prompt, caption, audience: row.audience, mediaUrl: upload.downloadUrl, thumbnailUrl: upload.thumbnailUrl },
  });
  await providers.mail.send({
    to: f.approvalEmail,
    subject: `Reworked ${f.name} post — day ${row.day}`,
    html: approvalEmail(f.name, upload.thumbnailUrl, caption, reviewUrl),
  });
  log.info({ day: row.day }, 'rework email sent');
}

/** Run every active funnel (daily cron entry). */
export async function runAllActive() {
  const active = await funnels.listActive();
  for (const funnel of active) {
    try {
      await runDaily(funnel);
    } catch (err) {
      childLogger({ module: 'funnelPoster', tenant_id: funnel.tenant_id, funnel: funnel.name }).error({ err: err.message }, 'funnel run failed');
    }
  }
}

// ---- helpers ---------------------------------------------------------------

async function markSheetPosted(sheets, sheetId, day, log) {
  try {
    const rowNumber = await sheets.findRowIndex(sheetId, SHEET_TAB, 'day', day);
    if (rowNumber <= 0) return;
    const rows = await sheets.readTab(sheetId, SHEET_TAB, { fresh: true });
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const idx = header.indexOf('status');
    if (idx === -1) return;
    let n = idx;
    let s = '';
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    await sheets.updateCells(sheetId, `${SHEET_TAB}!${s}${rowNumber}`, [['Posted']]);
  } catch (err) {
    log.warn({ err: err.message }, 'failed to mark sheet Posted');
  }
}

function approvalEmail(funnelName, thumbnailUrl, caption, reviewUrl) {
  return `<div style="font-family:system-ui">
    <p>New ${escapeHtml(funnelName)} post ready for review:</p>
    ${thumbnailUrl ? `<img src="${thumbnailUrl}" style="max-width:420px;border-radius:8px">` : ''}
    <pre style="white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:6px">${escapeHtml(caption)}</pre>
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
export default { runDaily, publish, rework, runAllActive, KIND };
