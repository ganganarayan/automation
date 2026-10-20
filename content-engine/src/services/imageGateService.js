/**
 * Images-selectable gate.
 *
 * Purpose:      Generate the still images for a video from scene prompts, email
 *               them for review, and let the operator keep the good ones or
 *               regenerate the marked ones before they are animated. Approving
 *               locks the kept set (the animation stage consumes it later).
 * Responsibility:
 *               - generateForFunnel / regenerate / finalizeSelection (side
 *                 effects: AI image gen, Drive upload, approval, email).
 *               - renderReview: the keep / regenerate grid shown at /review.
 *               - pure helpers (prompt building, selection math, naming) in
 *                 utils/imageGateSpec.js so they unit-test without settings.
 * Dependencies: providerFactory, approvalService, funnelsRepository,
 *               approvalRepository, utils/imageGateSpec, logger.
 */
import { buildProviders } from './providerFactory.js';
import * as approvalService from './approvalService.js';
import * as funnels from '../repositories/funnelsRepository.js';
import { setPayload } from '../repositories/approvalRepository.js';
import { childLogger } from '../core/logger.js';
import { ExternalAPIError } from '../core/errors.js';
import {
  mapImageSize,
  clampCount,
  defaultScenePrompts,
  buildImageName,
  selectKept,
} from '../utils/imageGateSpec.js';

export const KIND = 'image_gate';

async function loadFunnel(funnelId) {
  const funnel = await funnels.get(Number(funnelId));
  if (!funnel) throw new ExternalAPIError(`funnel ${funnelId} not found`);
  const cfg = await funnels.getConfig(funnel.id).catch(() => ({}));
  return { funnel, cfg };
}

/** Generate one image and upload it to the funnel's Drive folder. */
async function makeImage(providers, folderId, size, prompt, name) {
  const buf = await providers.llm.generateImage({ prompt, size });
  const up = await providers.storage.uploadPng(folderId, name, buf);
  return { id: up.id, url: up.downloadUrl, thumb: up.thumbnailUrl, prompt, keep: true };
}

/** Validate a funnel can generate (so a UI trigger fails fast with a reason). */
export async function precheck({ tenantId = 'default', funnelId }) {
  const providers = await buildProviders(tenantId);
  const { cfg } = await loadFunnel(funnelId);
  if (!providers.resolved.openai.apiKey) throw new ExternalAPIError('OpenAI key not set — add it in content-engine settings');
  if (!cfg.drive_folder_id) throw new ExternalAPIError('This funnel has no Drive folder (set it in step 1)');
  return true;
}

/**
 * Generate the first batch of stills for a funnel and email them for review.
 * @returns {Promise<{ id, reviewUrl, count }>}
 */
export async function generateForFunnel({ tenantId = 'default', funnelId, prompts, topic = '', count }) {
  const log = childLogger({ module: 'imageGate', tenant_id: tenantId });
  const providers = await buildProviders(tenantId);
  const { funnel, cfg } = await loadFunnel(funnelId);

  if (!providers.resolved.openai.apiKey) throw new ExternalAPIError('OpenAI key not set — add it in content-engine settings');
  if (!cfg.drive_folder_id) throw new ExternalAPIError('This funnel has no Drive folder (set it in step 1)');

  const size = mapImageSize(cfg.image_size);
  const n = clampCount(count ?? cfg.image_count, 4);
  const finalPrompts = Array.isArray(prompts) && prompts.length
    ? prompts
    : defaultScenePrompts({ count: n, style: cfg.image_style, topic });
  const stamp = Date.now().toString(36);

  const images = [];
  for (let i = 0; i < finalPrompts.length; i += 1) {
    images.push(await makeImage(providers, cfg.drive_folder_id, size, finalPrompts[i], buildImageName('img', i, stamp)));
  }

  const approvalEmail = cfg.approval_email || providers.resolved.emails.approvalGita;
  const payload = { funnelId: funnel.id, funnelName: funnel.name, size, approvalEmail, round: 1, images };
  const { id, reviewUrl } = await approvalService.createRequest({ tenantId, kind: KIND, payload });
  await providers.mail.send({
    to: approvalEmail,
    subject: `Review images — ${funnel.name} (${images.length})`,
    html: reviewEmailHtml(funnel.name, images, reviewUrl),
  });
  log.info({ funnel: funnel.name, count: images.length }, 'image gate sent');
  return { id, reviewUrl, count: images.length };
}

/** Regenerate the marked images, keep the rest, and re-send for review. */
export async function regenerate(approval, body) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'imageGate', tenant_id: tenantId });
  const p = approval.payload || {};
  const images = Array.isArray(p.images) ? p.images : [];
  const regenIds = Array.isArray(body?.regen) ? body.regen : [];
  const promptMap = (body && body.prompts) || {};
  if (!regenIds.length) return; // nothing marked

  const providers = await buildProviders(tenantId);
  const { cfg } = await loadFunnel(p.funnelId);
  const size = p.size || mapImageSize(cfg.image_size);
  const stamp = Date.now().toString(36);

  const next = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    if (regenIds.includes(img.id)) {
      const prompt = (promptMap[img.id] || img.prompt || '').toString();
      next.push(await makeImage(providers, cfg.drive_folder_id, size, prompt, buildImageName('img', i, stamp)));
    } else {
      next.push(img);
    }
  }

  const approvalEmail = p.approvalEmail || cfg.approval_email || providers.resolved.emails.approvalGita;
  const payload = { ...p, size, approvalEmail, round: (p.round || 1) + 1, images: next };
  const { reviewUrl } = await approvalService.createRequest({ tenantId, kind: KIND, payload });
  await providers.mail.send({
    to: approvalEmail,
    subject: `Images reworked — ${p.funnelName || 'funnel'} (round ${payload.round})`,
    html: reviewEmailHtml(p.funnelName || 'funnel', next, reviewUrl),
  });
  log.info({ regen: regenIds.length, round: payload.round }, 'image gate regenerated');
}

/** Approve: record the kept selection (the animation stage consumes it). */
export async function finalizeSelection(approval, body) {
  const tenantId = approval.tenant_id;
  const log = childLogger({ module: 'imageGate', tenant_id: tenantId });
  const p = approval.payload || {};
  const images = Array.isArray(p.images) ? p.images : [];
  const keepIds = Array.isArray(body?.keep) ? body.keep : [];
  const kept = selectKept(images, keepIds);

  await setPayload(approval.id, { ...p, kept: kept.map((i) => ({ id: i.id, url: i.url, prompt: i.prompt })) });

  const to = p.approvalEmail;
  if (to) {
    try {
      const providers = await buildProviders(tenantId);
      await providers.mail.send({
        to,
        subject: `Images locked — ${p.funnelName || 'funnel'} (${kept.length})`,
        text: `${kept.length} image(s) kept. They become animated clips when the animation stage runs.`,
      });
    } catch (err) {
      log.warn({ err: err.message }, 'confirmation email failed');
    }
  }
  log.info({ kept: kept.length, of: images.length }, 'image selection locked');
}

/** Register the image_gate approval kind (approve / regenerate / review page). */
export function registerKind() {
  approvalService.onKind(KIND, {
    onApprove: (approval, body) => finalizeSelection(approval, body),
    onRework: (approval, _note, body) => regenerate(approval, body),
    renderReview,
  });
}

// ---- rendering -------------------------------------------------------------

function reviewEmailHtml(funnelName, images, reviewUrl) {
  const thumbs = images
    .slice(0, 12)
    .map((i) => `<img src="${esc(i.thumb || i.url)}" alt="" width="120" style="border-radius:6px;margin:2px">`)
    .join('');
  return `<p>${esc(String(images.length))} images are ready for <b>${esc(funnelName)}</b>.</p>
    <p>${thumbs}</p>
    <p><a href="${esc(reviewUrl)}">Review — keep or regenerate</a></p>`;
}

/** The keep / regenerate grid shown at /review/:token. */
export function renderReview(approval, token) {
  const p = approval.payload || {};
  const images = Array.isArray(p.images) ? p.images : [];
  const cards = images
    .map(
      (img, i) => `<div class="card">
      <img src="${esc(img.thumb || img.url)}" alt="scene ${i + 1}" loading="lazy">
      <label class="keep"><input type="checkbox" class="k" data-id="${esc(img.id)}" checked> Keep</label>
      <label class="regen"><input type="checkbox" class="r" data-id="${esc(img.id)}"> Regenerate</label>
      <textarea class="p" data-id="${esc(img.id)}" rows="2">${esc(img.prompt || '')}</textarea>
    </div>`,
    )
    .join('');

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review images — ${esc(p.funnelName || 'funnel')}</title>
<style>
 body{font-family:system-ui;max-width:900px;margin:1.5rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.3rem}.sub{color:#555;font-size:.9rem;margin:.2rem 0 1rem}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem}
 .card{border:1px solid #e3e3e3;border-radius:10px;padding:.6rem;background:#fafafa}
 .card img{width:100%;border-radius:6px;display:block;background:#eee;aspect-ratio:2/3;object-fit:cover}
 .card label{display:flex;align-items:center;gap:.4rem;font-size:.85rem;margin:.4rem 0 0}
 .card .regen{color:#b45309}
 textarea{width:100%;margin-top:.4rem;font-size:.78rem;border:1px solid #ddd;border-radius:6px;padding:.3rem}
 .bar{position:sticky;bottom:0;background:#fff;border-top:1px solid #eee;padding:1rem 0;margin-top:1.3rem;display:flex;gap:.75rem;flex-wrap:wrap}
 button{padding:.7rem 1.3rem;border:0;border-radius:8px;font-size:1rem;cursor:pointer}
 .approve{background:#0a7d32;color:#fff}.rework{background:#b45309;color:#fff}
 #msg{font-size:.9rem;margin-left:.5rem;align-self:center}
</style>
<h1>Review images — ${esc(p.funnelName || 'funnel')}</h1>
<p class="sub">Round ${esc(String(p.round || 1))} · ${esc(String(images.length))} images. Untick <b>Keep</b> to drop one; tick <b>Regenerate</b> (optionally edit its prompt) to re-roll it.</p>
<div class="grid">${cards || '<p>No images.</p>'}</div>
<div class="bar">
  <button class="approve" onclick="send('approve')">Approve selection</button>
  <button class="rework" onclick="send('rework')">Regenerate marked</button>
  <span id="msg"></span>
</div>
<script>
 function ids(sel){return Array.from(document.querySelectorAll(sel)).filter(e=>e.checked).map(e=>e.dataset.id);}
 function prompts(){const m={};document.querySelectorAll('textarea.p').forEach(t=>{m[t.dataset.id]=t.value;});return m;}
 async function send(decision){
   const msg=document.getElementById('msg');
   const regen=ids('.r');
   if(decision==='rework' && regen.length===0){msg.textContent='Tick at least one image to regenerate.';return;}
   msg.textContent=decision==='approve'?'Locking selection…':'Regenerating…';
   const body={decision,keep:ids('.k'),regen:regen,prompts:prompts()};
   const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   document.body.innerHTML=await r.text();
 }
</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { KIND, generateForFunnel, regenerate, finalizeSelection, registerKind, renderReview };
