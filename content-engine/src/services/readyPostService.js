/**
 * Ready-video direct post service.
 *
 * Purpose:      The "pick already-made videos from the funnel's Drive folder and
 *               post them directly via Post-for-Me" path — bypassing the whole
 *               generation pipeline (research/script/images/animate/voiceover/
 *               transcript/stitch). The operator tick-selects unposted videos,
 *               gives each a caption and a schedule, and they post in selection
 *               order. No review email (the video is finished) — a posted-summary
 *               email is sent afterwards. Each post is recorded as a posted
 *               instance so it shows in the same log, with its stages marked
 *               skipped and zero AI cost.
 * Responsibility: Orchestration + side effects; pure logic in utils/readyPostSpec.
 * Dependencies: funnelsRepository, instanceService, instanceRepository,
 *               providerFactory, publishProvider, storageProvider, instanceSpec,
 *               utils/{readyPostSpec,reviewSpec,time}, logger.
 */
import * as funnels from '../repositories/funnelsRepository.js';
import * as instanceService from '../services/instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import { buildProviders } from './providerFactory.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { dlUrl } from '../providers/storageProvider.js';
import { buildInitialSteps, patchStep } from '../utils/instanceSpec.js';
import { formatIst } from '../utils/time.js';
import { driveEmbedUrl } from '../utils/reviewSpec.js';
import {
  filterReadyVideos,
  defaultCaption,
  defaultSlotsIso,
  parseIstDateTime,
  normalizeSelections,
} from '../utils/readyPostSpec.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'readyPost' });

async function loadFunnel(funnelId) {
  const funnel = await funnels.get(Number(funnelId));
  if (!funnel) throw new Error(`funnel ${funnelId} not found`);
  const resolved = await funnels.resolve(funnel);
  return { funnel, resolved };
}

/** The unposted videos in a funnel's Drive folder, newest first. */
export async function listReadyVideos({ tenantId = 'default', funnelId }) {
  const { funnel, resolved } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  if (!resolved.driveFolder) return { funnel, resolved, videos: [] };
  const files = await providers.storage.listFiles(resolved.driveFolder);
  const videos = filterReadyVideos(files)
    .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime }))
    .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  return { funnel, resolved, videos };
}

/** Record one direct post as a posted instance (stages skipped, cost 0). */
async function recordPostedInstance({ funnel, driveId, caption, scheduledIso, ref }) {
  const inst = await instanceService.createForFunnel({
    tenantId: funnel.tenant_id,
    funnel,
    title: `Ready video — ${formatIst(scheduledIso, { withTime: false })}`,
    scheduledFor: scheduledIso ? new Date(scheduledIso) : null,
  });
  let steps = buildInitialSteps();
  for (const k of ['script', 'images', 'animate', 'voiceover', 'transcript']) steps = patchStep(steps, k, { status: 'skipped' });
  steps = patchStep(steps, 'stitch', { status: 'done', artifacts: { video: { driveId } } });
  steps = patchStep(steps, 'publish', { status: 'done', artifacts: { posts: ref ? [ref] : [], caption } });
  await instanceRepo.saveSteps(inst.id, steps, 0);
  await instanceRepo.lockAsPosted(inst.id, { postRefs: ref ? [ref] : [], postedAt: scheduledIso ? new Date(scheduledIso) : new Date() });
  return inst.id;
}

/**
 * Post the tick-selected videos, in selection order, each at its own schedule
 * (explicit "DD-MM-YYYY HH:MM" IST, else the next sequential daily slot). Sends a
 * posted-summary email. Returns a per-item result list.
 */
export async function postSelections({ tenantId = 'default', funnelId, selections }) {
  const { funnel, resolved } = await loadFunnel(funnelId);
  const providers = await buildProviders(funnel.tenant_id || tenantId);
  const clean = normalizeSelections(selections);
  if (!clean.length) throw new Error('no videos selected');

  if (!resolved.postformeKey) throw new Error('This funnel has no Post for Me API key (set it in settings)');
  const accounts = Array.isArray(resolved.accounts) ? resolved.accounts : [];
  if (!accounts.length) throw new Error('This funnel has no Post for Me accounts configured');
  const publish = createPostForMeProvider({ apiKey: resolved.postformeKey }, log);

  const slots = defaultSlotsIso(resolved.publishTime, clean.length);
  const results = [];
  for (let i = 0; i < clean.length; i += 1) {
    const sel = clean[i];
    const scheduledIso = (sel.scheduledAt && parseIstDateTime(sel.scheduledAt)) || slots[i] || null;
    const caption = sel.caption.trim() || defaultCaption(resolved);
    try {
      await providers.storage.shareAnyone(sel.driveId);
      const result = await publish.createPost({
        accountIds: accounts,
        caption,
        mediaUrl: dlUrl(sel.driveId),
        scheduledAt: scheduledIso || undefined,
      });
      const ref = result && result.id ? result.id : null;
      const instanceId = await recordPostedInstance({ funnel, driveId: sel.driveId, caption, scheduledIso, ref });
      try {
        await providers.storage.renameFile(sel.driveId, `POSTED - ${sel.name || sel.driveId}`);
      } catch (err) {
        log.warn({ err: err.message, driveId: sel.driveId }, 'POSTED tag failed (posted anyway)');
      }
      results.push({ driveId: sel.driveId, name: sel.name, scheduledIso, caption, ref, instanceId, ok: true });
      log.info({ funnel: funnel.name, driveId: sel.driveId, scheduledIso, ref }, 'ready video posted');
    } catch (err) {
      log.error({ err: err.message, driveId: sel.driveId }, 'ready video post failed');
      results.push({ driveId: sel.driveId, name: sel.name, ok: false, error: err.message });
    }
  }

  await sendPostedEmail({ providers, funnel, resolved, results });
  return { funnel: funnel.name, posted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

async function sendPostedEmail({ providers, funnel, resolved, results }) {
  const to = resolved.approvalEmail || providers.resolved?.emails?.approvalGita || '';
  const ok = results.filter((r) => r.ok);
  if (!to || !ok.length) return;
  const rows = ok
    .map(
      (r) => `<tr>
        <td><a href="${esc(driveEmbedUrl(r.driveId))}" target="_blank" rel="noopener">▶ ${esc(r.name || 'video')}</a></td>
        <td>${esc(formatIst(r.scheduledIso))}</td>
        <td><pre style="white-space:pre-wrap;margin:0;font:inherit">${esc(r.caption)}</pre></td>
      </tr>`,
    )
    .join('');
  const html = `<p><b>${esc(String(ok.length))}</b> ready video(s) scheduled for <b>${esc(funnel.name)}</b> via Post for Me.</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse">
      <thead><tr><th>Video</th><th>Scheduled (IST)</th><th>Caption</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  try {
    await providers.mail.send({ to, subject: `Posted ${ok.length} ready video(s) — ${funnel.name}`, html });
  } catch (err) {
    log.warn({ err: err.message }, 'posted-summary email failed');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { listReadyVideos, postSelections };
