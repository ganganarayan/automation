/**
 * Instance review service (two checkpoints + correction rework).
 *
 * Purpose:      The review/approval machinery around a pipeline instance: email a
 *               review (script, then final) with an in-email Google-Drive player,
 *               host the review page, and on the operator's decision move the
 *               instance through its lifecycle — approve script => stages run
 *               (slice 5) => final review; approve final => post + lock; reject
 *               (with a required correction note) => rework the SAME instance_id
 *               on a new round.
 * Responsibility:
 *               - requestReview (side effects: approval row + email).
 *               - onApprove / onRework handlers wired to approvalService.
 *               - renderReview: the hosted review page (script text, or the final
 *                 reel via Drive's /preview iframe).
 *               Pure transition / URL logic lives in utils/reviewSpec.
 * Dependencies: approvalService, instanceService, instanceRepository,
 *               funnelsRepository, providerFactory, utils/reviewSpec, utils/time.
 *
 * SEAMS for slice 5 are marked below — the stage workers (script/image/animate/
 * voiceover/transcript/stitch generation) and the real Post-for-Me dispatch
 * attach there. Slice 4 wires the checkpoints + rework loop only.
 */
import * as approvalService from './approvalService.js';
import * as instanceService from './instanceService.js';
import * as instanceRepo from '../repositories/instanceRepository.js';
import * as funnels from '../repositories/funnelsRepository.js';
import { buildProviders } from './providerFactory.js';
import { childLogger } from '../core/logger.js';
import {
  isCheckpoint,
  rejectTransition,
  normalizeNote,
  driveEmbedUrl,
  driveThumbUrl,
} from '../utils/reviewSpec.js';

export const KIND = 'instance_review';

const log = childLogger({ module: 'instanceReview' });

// ---- artifact extraction ---------------------------------------------------

function stepArtifact(steps, key, field) {
  const s = (steps || []).find((x) => x.key === key);
  return s && s.artifacts ? s.artifacts[field] : undefined;
}

function finalVideoId(steps) {
  const s = (steps || []).find((x) => x.key === 'stitch');
  return s && s.artifacts && s.artifacts.video ? s.artifacts.video.driveId : '';
}

/** The approval recipient: the funnel's approval_email, else the tenant default. */
async function recipientFor(instance, resolved) {
  if (instance.funnel_id) {
    const funnel = await funnels.get(instance.funnel_id).catch(() => null);
    if (funnel) {
      const cfg = await funnels.resolve(funnel).catch(() => ({}));
      if (cfg.approvalEmail) return cfg.approvalEmail;
    }
  }
  return resolved?.emails?.approvalGita || '';
}

// ---- requesting a review ---------------------------------------------------

/**
 * Create a review request for a checkpoint of an instance and email it (with the
 * in-email Drive player for the final reel). Reflects the checkpoint on the
 * instance (script_review / final_review). Returns { id, reviewUrl, approvalEmail }.
 */
export async function requestReview({ tenantId = 'default', instanceId, checkpoint = 'script' }) {
  if (!isCheckpoint(checkpoint)) throw new Error(`unknown checkpoint: ${checkpoint}`);
  const instance = await instanceService.get(instanceId);
  if (!instance) throw new Error(`instance ${instanceId} not found`);

  const steps = instanceService.parseSteps(instance);
  const providers = await buildProviders(instance.tenant_id || tenantId);
  const approvalEmail = await recipientFor(instance, providers.resolved);

  const payload = {
    instanceId: instance.id,
    checkpoint,
    round: instance.round || 1,
    funnelName: instance.funnel_name || '',
    title: instance.title || '',
    scriptText: checkpoint === 'script' ? String(stepArtifact(steps, 'script', 'text') || '') : '',
    videoId: checkpoint === 'final' ? String(finalVideoId(steps) || '') : '',
    scheduledFor: instance.scheduled_for ? new Date(instance.scheduled_for).toISOString() : null,
    approvalEmail,
  };

  const { id, reviewUrl } = await approvalService.createRequest({ tenantId: instance.tenant_id, kind: KIND, payload });

  // Reflect the open checkpoint on the instance.
  await instanceRepo.setStatus(instance.id, checkpoint === 'script' ? 'script_review' : 'final_review');

  if (approvalEmail) {
    try {
      await providers.mail.send({
        to: approvalEmail,
        subject: subjectFor(payload),
        html: reviewEmailHtml(payload, reviewUrl),
      });
      log.info({ instance: instance.id, checkpoint, round: payload.round, to: approvalEmail }, 'review email sent');
    } catch (err) {
      // Don't fail the request if SMTP is unset/misconfigured — the hosted review
      // link still works; surface the reason in logs.
      log.warn({ err: err.message, instance: instance.id, checkpoint }, 'review email failed');
    }
  } else {
    log.warn({ instance: instance.id, checkpoint }, 'no approval email configured — review link not emailed');
  }

  return { id, reviewUrl, approvalEmail };
}

// ---- decision handlers (wired to approvalService) --------------------------

/** Approve: advance the instance. script => running (stages run, slice 5) then
 *  final review; final => post + lock. */
export async function onApprove(approval) {
  const p = approval.payload || {};
  const instanceId = p.instanceId;
  if (!instanceId) return;

  if (p.checkpoint === 'script') {
    await instanceService.updateStep(instanceId, 'script', { status: 'done' });
    await instanceRepo.setStatus(instanceId, 'running');
    log.info({ instance: instanceId, round: p.round }, 'script approved — instance running');
    // SEAM (slice 5): run image -> animate -> voiceover -> transcript -> stitch
    // (writing artifacts + real cost), then requestReview({ instanceId,
    // checkpoint: 'final' }). No-op now: the instance waits at 'running'.
    // TODO(slice5): instanceService.runStages(instanceId).then(() =>
    //   requestReview({ instanceId, checkpoint: 'final' }));
  } else if (p.checkpoint === 'final') {
    // SEAM (slice 5): dispatch the reel to Post-for-Me at scheduled_for and
    // capture the post refs before locking. No-op now: lock with empty refs.
    const postedAt = p.scheduledFor ? new Date(p.scheduledFor) : new Date();
    const ok = await instanceRepo.lockAsPosted(instanceId, { postRefs: [], postedAt });
    log.info({ instance: instanceId, locked: ok, postedAt }, 'final approved — posted + locked');
  }
}

/** Reject: record the correction, bump the round on the SAME instance, and
 *  re-send the checkpoint (slice 5 regenerates from the correction first). */
export async function onRework(approval, note) {
  const p = approval.payload || {};
  const instanceId = p.instanceId;
  if (!instanceId) return;

  const correction = normalizeNote(note);
  const { status } = rejectTransition(p.checkpoint);
  await instanceRepo.setStatus(instanceId, status, correction);
  const round = await instanceRepo.bumpRound(instanceId);
  log.info({ instance: instanceId, checkpoint: p.checkpoint, round, correction }, 'rework requested');

  // SEAM (slice 5): regenerate using `correction` — the script (script reject) or
  // the downstream stages (final reject) — THEN re-send. For now re-send the same
  // checkpoint so the loop (same instance_id, new round) is exercised end to end.
  await requestReview({ tenantId: approval.tenant_id, instanceId, checkpoint: p.checkpoint }).catch((err) =>
    log.error({ err: err.message, instance: instanceId }, 'rework re-send failed'),
  );
}

/** Register the instance_review approval kind (approve / rework / review page). */
export function registerKind() {
  approvalService.onKind(KIND, { onApprove, onRework, renderReview });
}

// ---- rendering -------------------------------------------------------------

function subjectFor(p) {
  const who = p.funnelName || 'funnel';
  const round = p.round > 1 ? ` (round ${p.round})` : '';
  return p.checkpoint === 'final' ? `Final review — ${who}${round}` : `Review script — ${who}${round}`;
}

/**
 * The review email. For the final checkpoint it carries the in-email Drive
 * player: a poster thumbnail with a ▶ overlay that opens Drive's /preview player
 * in the browser (robust across mail clients that strip iframes), plus the link
 * to the hosted review page where the decision is made.
 */
function reviewEmailHtml(p, reviewUrl) {
  const who = esc(p.funnelName || 'funnel');
  const roundLine = p.round > 1 ? `<p style="color:#b45309">Rework round ${esc(String(p.round))}.</p>` : '';

  if (p.checkpoint === 'final') {
    const poster = p.videoId
      ? `<a href="${esc(driveEmbedUrl(p.videoId))}" target="_blank" rel="noopener"
            style="display:inline-block;position:relative;text-decoration:none">
           <img src="${esc(driveThumbUrl(p.videoId, 'w640'))}" alt="video poster"
                width="320" style="border-radius:10px;display:block;max-width:100%">
           <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                 font-size:2.4rem;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.6)">▶</span>
         </a>`
      : '<p>(no video yet)</p>';
    return `<p>The final reel for <b>${who}</b> is ready for review.</p>
      ${roundLine}
      <p>${poster}</p>
      <p><a href="${esc(driveEmbedUrl(p.videoId))}" target="_blank" rel="noopener">▶ Play the video</a></p>
      <p><a href="${esc(reviewUrl)}" style="background:#0a7d32;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;display:inline-block">Approve &amp; post, or request a change</a></p>`;
  }

  const preview = esc((p.scriptText || '').slice(0, 1200)) + ((p.scriptText || '').length > 1200 ? '…' : '');
  return `<p>The script for <b>${who}</b> is ready for review.</p>
    ${roundLine}
    <pre style="white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:6px;font-size:.9rem">${preview || '(empty)'}</pre>
    <p><a href="${esc(reviewUrl)}" style="background:#0a7d32;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;display:inline-block">Approve script, or request a change</a></p>`;
}

/**
 * The hosted review page shown at /review/:token. Script: the script text.
 * Final: the reel via Drive's /preview iframe. Both: Approve, or a correction
 * note (required) + Request change. The note is enforced client-side here because
 * a custom renderReview skips the generic server-side note check.
 */
export function renderReview(approval, token) {
  const p = approval.payload || {};
  const who = esc(p.funnelName || 'funnel');
  const isFinal = p.checkpoint === 'final';
  const title = isFinal ? 'Final review' : 'Script review';
  const approveLabel = isFinal ? 'Approve &amp; post' : 'Approve script';

  const media = isFinal
    ? (p.videoId
      ? `<iframe class="player" allow="autoplay" src="${esc(driveEmbedUrl(p.videoId))}"></iframe>`
      : '<p class="hint">No video attached yet.</p>')
    : `<pre class="script">${esc(p.scriptText || '(empty)')}</pre>`;

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${who}</title>
<style>
 body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem}.sub{color:#555;font-size:.9rem;margin:.1rem 0 1rem}
 .player{width:100%;height:60vh;border:0;border-radius:10px;background:#000}
 .script{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:8px;font-size:.95rem}
 textarea{width:100%;min-height:4.5rem;margin:.4rem 0;padding:.5rem;border:1px solid #ccc;border-radius:6px}
 .row{display:flex;gap:.75rem;margin-top:1rem;flex-wrap:wrap;align-items:center}
 button{padding:.7rem 1.3rem;border:0;border-radius:6px;font-size:1rem;cursor:pointer}
 .approve{background:#0a7d32;color:#fff}.rework{background:#b45309;color:#fff}
 #msg{font-size:.9rem}
</style>
<h1>${esc(title)} — ${who}</h1>
<p class="sub">${esc(p.title || '')}${p.round > 1 ? ` · rework round ${esc(String(p.round))}` : ''}</p>
${media}
<div class="row"><button class="approve" onclick="send('approve')">${approveLabel}</button></div>
<h3>Or request a change</h3>
<textarea id="note" placeholder="Describe the correction (required to request a change)"></textarea>
<div class="row"><button class="rework" onclick="send('rework')">Request change</button><span id="msg"></span></div>
<script>
 async function send(decision){
   const msg=document.getElementById('msg');
   const note=document.getElementById('note').value.trim();
   if(decision==='rework' && !note){ msg.textContent='Please describe the correction.'; return; }
   msg.textContent=decision==='approve'?'Submitting…':'Sending back for rework…';
   const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,note})});
   document.body.innerHTML=await r.text();
 }
</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { KIND, requestReview, onApprove, onRework, registerKind, renderReview };
