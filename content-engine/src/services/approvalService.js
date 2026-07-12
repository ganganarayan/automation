/**
 * Approval service (email approval + rework loop).
 *
 * Purpose:      Replace the legacy "send-and-wait" email approval with a durable,
 *               restart-safe flow: content is emailed with a signed link to a
 *               hosted review page offering Approve & Publish or Rework (+note).
 * Responsibility:
 *               - Sign/verify single-use tokens (HMAC over the approval id).
 *               - Persist approval state so restarts are safe.
 *               - Dispatch approve/rework to per-kind handlers registered by
 *                 the content modules (the rework loop lives in the handler,
 *                 which regenerates and calls createRequest again).
 *               - Mount GET/POST /review/:token.
 * Dependencies: approvalRepository, settings, crypto.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as approvals from '../repositories/approvalRepository.js';
import { settings } from '../settings/index.js';
import { childLogger } from '../core/logger.js';

const handlers = new Map(); // kind -> { onApprove(approval), onRework(approval, note) }
const log = childLogger({ module: 'approvals' });

/** Register approve/rework handlers for a content kind. */
export function onKind(kind, { onApprove, onRework }) {
  handlers.set(kind, { onApprove, onRework });
}

function sign(id) {
  const mac = createHmac('sha256', settings.app.secret).update(id).digest('hex');
  return `${id}.${mac}`;
}

function verify(token) {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const id = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', settings.app.secret).update(id).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

/**
 * Create an approval request and return its review URL.
 * @param {object} args - { tenantId, kind, payload }
 * @returns {Promise<{ id: string, reviewUrl: string }>}
 */
export async function createRequest({ tenantId = 'default', kind, payload }) {
  const id = randomUUID();
  await approvals.create({ id, tenantId, kind, payload });
  const token = sign(id);
  const base = settings.app.publicBaseUrl || '';
  const reviewUrl = `${base}/api/v1/review/${encodeURIComponent(token)}`;
  return { id, reviewUrl };
}

/** Mount the review routes on a router. */
export function register(router) {
  router.get('/review/:token', async (req, res, next) => {
    try {
      const id = verify(req.params.token);
      if (!id) return res.status(400).type('html').send(page('Invalid or expired link', ''));
      const approval = await approvals.findById(id);
      if (!approval) return res.status(404).type('html').send(page('Not found', ''));
      if (approval.status === 'published' || approval.status === 'approved') {
        return res.type('html').send(page('Already handled', `This item is already ${approval.status}.`));
      }
      res.type('html').send(reviewPage(req.params.token, approval));
    } catch (err) {
      next(err);
    }
  });

  router.post('/review/:token', async (req, res, next) => {
    try {
      const id = verify(req.params.token);
      if (!id) return res.status(400).json({ error: 'invalid token' });

      // Single-use: atomically consume the token.
      const approval = await approvals.consumeToken(id);
      if (!approval) return res.status(409).type('html').send(page('Link already used', 'This review link was already used.'));

      const decision = (req.body?.decision || '').toLowerCase();
      const note = (req.body?.note || '').toString();
      const handler = handlers.get(approval.kind);

      if (decision === 'approve') {
        await approvals.setStatus(id, 'approved');
        res.type('html').send(page('Approved', 'Publishing now. You can close this tab.'));
        Promise.resolve(handler?.onApprove?.(approval)).catch((e) =>
          log.error({ err: e.message, id }, 'approve handler failed'),
        );
      } else if (decision === 'rework') {
        if (!note.trim()) return res.status(400).type('html').send(page('Note required', 'Please describe what to change.'));
        await approvals.reopenForRework(id, note);
        res.type('html').send(page('Rework requested', 'Regenerating and re-sending for approval.'));
        Promise.resolve(handler?.onRework?.(approval, note)).catch((e) =>
          log.error({ err: e.message, id }, 'rework handler failed'),
        );
      } else {
        res.status(400).json({ error: 'decision must be approve or rework' });
      }
    } catch (err) {
      next(err);
    }
  });
}

// ---- HTML helpers ----------------------------------------------------------

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}</style><h1>${esc(title)}</h1><p>${esc(body)}</p>`;
}

function reviewPage(token, approval) {
  const p = approval.payload || {};
  const media = p.mediaUrl || p.thumbnailUrl || p.videoThumbnailUrl || '';
  const caption = p.caption || '';
  const videoUrl = p.videoUrl || '';
  const editableCaption = p.editableCaption === true;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review: ${esc(approval.kind)}</title>
<style>
 body{font-family:system-ui;max-width:680px;margin:2rem auto;padding:0 1rem;color:#111}
 img{max-width:100%;border-radius:8px}
 textarea{width:100%;min-height:5rem;margin:.5rem 0}
 .row{display:flex;gap:.75rem;margin-top:1rem;flex-wrap:wrap}
 button{padding:.7rem 1.3rem;border:0;border-radius:6px;font-size:1rem;cursor:pointer}
 .approve{background:#0a7d32;color:#fff}.rework{background:#b45309;color:#fff}
 pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:6px}
</style>
<h1>Review — ${esc(approval.kind)}</h1>
${media ? `<img src="${esc(media)}" alt="preview">` : ''}
${videoUrl ? `<p><a href="${esc(videoUrl)}" target="_blank" rel="noopener">Open video</a></p>` : ''}
<h3>Caption</h3>
${editableCaption
  ? `<textarea id="caption">${esc(caption)}</textarea>`
  : `<pre id="captionText">${esc(caption)}</pre>`}
<div class="row">
  <button class="approve" onclick="send('approve')">Approve &amp; Publish</button>
</div>
<h3>Or request a change</h3>
<textarea id="note" placeholder="What should change?"></textarea>
<div class="row"><button class="rework" onclick="send('rework')">Request Rework</button></div>
<script>
async function send(decision){
  const note=document.getElementById('note').value;
  const capEl=document.getElementById('caption');
  const body={decision,note};
  if(capEl) body.caption=capEl.value;
  const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  document.body.innerHTML=await r.text();
}
</script>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { onKind, createRequest, register };
