/**
 * Video pipeline (full voiceover pipeline + simple reel poster).
 *
 * Purpose:      Produce Gita video posts. The full pipeline (off by default)
 *               renders a movie from a Drive voiceover + AI images via JSON2Video
 *               with approval; the simple poster publishes an existing reel with
 *               an editable caption.
 * Responsibility: runFull / publishFull / runSimple / publishSimple, plus the
 *               deterministic helpers (mvhd duration probe, seeded persona,
 *               movie spec builder).
 * Dependencies: providers (sheets, storage, llm, video, publish, mail),
 *               scheduling utils, tenantSettings, approvals.
 */
import { DateTime } from 'luxon';
import { buildProviders } from './providerFactory.js';
import * as approvalService from './approvalService.js';
import { setStatus } from '../repositories/approvalRepository.js';
import { gitaVideoScheduledAt, simpleVideoScheduledAt } from '../utils/scheduling.js';
import {
  probeMp4DurationSeconds,
  seededPersona,
  buildVideoImagePrompts,
  buildMovieSpec,
} from '../utils/videoSpec.js';
import { childLogger } from '../core/logger.js';
import { settings } from '../settings/index.js';

const FULL_KIND = 'video';
const SIMPLE_KIND = 'video_simple';
const SHEET_TAB = 'Sheet1';

// ---- full pipeline ---------------------------------------------------------

async function nextReadyVideoRow(providers, resolved) {
  const rows = await providers.sheets.readTab(resolved.sheets.video, SHEET_TAB, { fresh: true });
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  for (const r of rows.slice(1)) {
    const status = String(r[col('status')] ?? '').trim().toLowerCase();
    const format = String(r[col('format')] ?? '').trim().toLowerCase();
    if (status === 'ready' && format === 'video') {
      return {
        day: r[col('day')],
        video_script: r[col('video_script')] || '',
        caption: r[col('caption')] || '',
        headline: r[col('headline')] || '',
        audience: r[col('audience')] || '',
        cta_time: r[col('cta_time')] || '',
        sthira_time: r[col('sthira_time')] || '',
      };
    }
  }
  return null;
}

export async function runFull({ tenantId = 'default' }) {
  const log = childLogger({ module: 'videoPipeline', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  if (!resolved.sheets.video) {
    log.warn('VIDEO_SHEET_ID not configured; skipping');
    return;
  }
  const row = await nextReadyVideoRow(providers, resolved);
  if (!row) {
    log.info('no Ready video row');
    return;
  }

  // Find and probe the voiceover file "Day{n}.".
  const files = await providers.storage.listFiles(resolved.drive.voiceoverFolder);
  const voice = files.find((f) => f.name?.startsWith(`Day${row.day}.`) || f.name?.startsWith(`Day ${row.day}.`));
  if (!voice) {
    log.warn({ day: row.day }, 'no voiceover file found');
    return;
  }
  await providers.storage.shareAnyone(voice.id);
  const voiceBuf = await providers.storage.download(voice.id);
  const duration = probeMp4DurationSeconds(voiceBuf);

  // Generate 4 consistent-person images.
  const persona = seededPersona(row.day, row.audience);
  const prompts = buildVideoImagePrompts(persona);
  const imageUrls = [];
  for (const prompt of prompts) {
    const img = await providers.llm.generateImage({ prompt, size: '1024x1536' });
    const up = await providers.storage.uploadPng(resolved.drive.gitaFolder, `video-day-${row.day}-${imageUrls.length}.png`, img);
    imageUrls.push(up.downloadUrl);
  }

  const spec = buildMovieSpec({
    voiceoverUrl: `https://drive.google.com/uc?export=download&id=${voice.id}`,
    imageUrls,
    durationSeconds: duration,
    ctaTime: row.cta_time,
    sthiraTime: row.sthira_time,
  });
  const videoUrl = await providers.video.renderAndWait(spec);

  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: FULL_KIND,
    payload: { day: row.day, caption: row.caption, videoUrl, videoThumbnailUrl: imageUrls[0] },
  });
  await providers.mail.send({
    to: resolved.emails.approvalGita,
    subject: `Approve Gita video — day ${row.day}`,
    html: `<p>Video ready: <a href="${videoUrl}">watch</a></p><pre>${escapeHtml(row.caption)}</pre>
      <p><a href="${reviewUrl}">Review &amp; Approve</a></p>`,
  });
  log.info({ day: row.day }, 'video approval email sent');
}

export async function publishFull(approval) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'videoPipeline', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};
  const accounts = resolved.postforme.gitaVideoAccounts || [];
  if (!accounts.length) {
    log.warn('no video accounts configured');
    return;
  }
  const scheduledAt = gitaVideoScheduledAt(DateTime.now().setZone(settings.tz)).toISO();
  await providers.publish.createPost({ accountIds: accounts, caption: p.caption, mediaUrl: p.videoUrl, scheduledAt });
  await markSheetPosted(providers, resolved.sheets.video, p.day, log);
  await setStatus(approval.id, 'published');
  log.info({ day: p.day }, 'gita video published');
}

// ---- simple reel poster ----------------------------------------------------

export async function runSimple({ tenantId = 'default' }) {
  const log = childLogger({ module: 'videoSimple', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const files = await providers.storage.listFiles(resolved.drive.reelsFolder);
  const oldest = files
    .filter((f) => (f.mimeType || '').startsWith('video') && !/POSTED/i.test(f.name || ''))
    .sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];

  if (!oldest) {
    await providers.mail.send({
      to: resolved.emails.approvalGita,
      subject: 'Gita reels: none left to post',
      text: 'No unposted reels remain in the Drive folder.',
    });
    log.info('no unposted reels');
    return;
  }

  await providers.storage.shareAnyone(oldest.id);
  const defaultCaption = `Take the assessment: ${resolved.links.gitaSimpleAssessment}`;
  const { reviewUrl } = await approvalService.createRequest({
    tenantId,
    kind: SIMPLE_KIND,
    payload: {
      fileId: oldest.id,
      fileName: oldest.name,
      caption: defaultCaption,
      editableCaption: true,
      mediaUrl: `https://drive.google.com/uc?export=download&id=${oldest.id}`,
    },
  });
  await providers.mail.send({
    to: resolved.emails.approvalGita,
    subject: `Approve Gita reel — ${oldest.name}`,
    html: `<p>Reel ready to post: ${escapeHtml(oldest.name)}</p><p><a href="${reviewUrl}">Review, edit caption &amp; Approve</a></p>`,
  });
  log.info({ file: oldest.name }, 'reel approval email sent');
}

export async function publishSimple(approval) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'videoSimple', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const resolved = providers.resolved;
  const p = approval.payload || {};
  const caption = (approval.note && approval.payload?.caption) || p.caption;
  const accounts = resolved.postforme.gitaAccounts || [];
  const scheduledAt = simpleVideoScheduledAt(DateTime.now().setZone(settings.tz)).toISO();

  if (accounts.length) {
    await providers.publish.createPost({ accountIds: accounts, caption, mediaUrl: p.mediaUrl, scheduledAt });
  }
  if (resolved.instagram.commentWebhookUrl) {
    import('../core/httpClient.js').then(({ request }) =>
      request(resolved.instagram.commentWebhookUrl, { method: 'POST', body: { file: p.fileName }, label: 'ig.comment', log, retries: 0 }).catch(() => {}),
    );
  }
  await providers.storage.renameFile(p.fileId, `POSTED - ${p.fileName}`);
  await setStatus(approval.id, 'published');
  log.info({ file: p.fileName }, 'reel published and renamed');
}

// ---- helpers ---------------------------------------------------------------

async function markSheetPosted(providers, sheetId, day, log) {
  try {
    const rowNumber = await providers.sheets.findRowIndex(sheetId, SHEET_TAB, 'day', day);
    if (rowNumber <= 0) return;
    const rows = await providers.sheets.readTab(sheetId, SHEET_TAB, { fresh: true });
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const idx = header.indexOf('status');
    if (idx === -1) return;
    let n = idx;
    let s = '';
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    await providers.sheets.updateCells(sheetId, `${SHEET_TAB}!${s}${rowNumber}`, [['Posted']]);
  } catch (err) {
    log.warn({ err: err.message }, 'failed to mark video sheet Posted');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export { FULL_KIND, SIMPLE_KIND };
export default {
  runFull, publishFull, runSimple, publishSimple,
  probeMp4DurationSeconds, seededPersona, buildVideoImagePrompts, buildMovieSpec,
  FULL_KIND, SIMPLE_KIND,
};
