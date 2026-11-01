/**
 * Module: Google Drive connect + the GitHub Actions ✂ Clean hooks.
 *
 * Purpose:      The one-time "Connect Google Drive" (Settings → Workspace →
 *               Google), and the endpoints the clean-video workflow calls back.
 * Responsibility: HTTP wiring only; logic in driveConnectService / readyPostService.
 * Dependencies: accessService, driveConnectService, readyPostService, cleanHookSpec.
 *
 * Routes (signed in):
 *   GET  /api/v1/admin/drive/status       { connected, email }
 *   GET  /api/v1/admin/drive/connect      → Google's consent screen
 *   GET  /api/v1/admin/drive/callback     Google sends the user back here
 *   POST /api/v1/admin/drive/disconnect
 * Routes (no sign-in — the X-Clean-Ticket header is a signed, expiring ticket
 * the app gave the workflow; nothing else is accepted):
 *   GET  /api/v1/hooks/clean/job          job details + a short-lived Drive token
 *   GET  /api/v1/hooks/clean/token        a fresh Drive token (just before the upload)
 *   GET  /api/v1/hooks/clean/card.png     the end card (?w=&h=)
 *   POST /api/v1/hooks/clean/progress     { phase, pct, doneSec, totalSec }
 *   POST /api/v1/hooks/clean/done         { fileId, durationSec }
 *   POST /api/v1/hooks/clean/fail         { error }
 */
import { keyOk, gateState } from '../services/accessService.js';
import * as driveConnect from '../services/driveConnectService.js';
import * as readyPost from '../services/readyPostService.js';
import { peekTicket } from '../utils/cleanHookSpec.js';

const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 16px;line-height:1.5}
a{color:#4b3fd6}</style></head><body><h2>${esc(title)}</h2><p>${esc(body)}</p>
<p><a href="/api/v1/admin/settings#content-engine">← Back to Settings</a></p></body></html>`;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/admin/drive/status', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const st = await driveConnect.status(req.tenantId || 'default');
      res.set('Cache-Control', 'no-store').json({ ok: true, connected: st.connected, email: st.email });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/admin/drive/connect', async (req, res) => {
    try {
      const state = await gateState(req);
      if (state !== 'ok') return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.redirect(await driveConnect.connectUrl({ tenantId: req.tenantId || 'default', baseUrl: baseUrlOf(req) }));
    } catch (err) {
      res.status(400).type('html').send(notePage('Could not start the Drive connect', err.message));
    }
  });

  router.get('/admin/drive/callback', async (req, res) => {
    try {
      const state = await gateState(req);
      if (state !== 'ok') return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      if (req.query.error) return res.type('html').send(notePage('Drive not connected', `Google said: ${req.query.error}`));
      const peek = peekTicket(String(req.query.state || '')) || {};
      const tenantId = await driveConnect.stateTenant(String(req.query.state || ''), peek.t);
      if (!tenantId) return res.status(400).type('html').send(notePage('Drive not connected', 'That link expired or did not start here. Press Connect Google Drive again.'));
      const { email } = await driveConnect.finishConnect({ tenantId, baseUrl: baseUrlOf(req), code: String(req.query.code || '') });
      log.info({ tenantId, email }, 'google drive connected');
      res.redirect(`/api/v1/admin/settings?${new URLSearchParams({ tenant: tenantId, saved: 'content-engine' })}#content-engine`);
    } catch (err) {
      log.warn({ err: err.message }, 'google drive connect failed');
      res.status(400).type('html').send(notePage('Drive not connected', err.message));
    }
  });

  router.post('/admin/drive/disconnect', async (req, res) => {
    try {
      if (!(await keyOk(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
      await driveConnect.disconnect(req.tenantId || 'default');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // --- Hooks the clean-video workflow calls ---
  const hook = (fn) => async (req, res) => {
    try {
      const ticket = String(req.get('x-clean-ticket') || '');
      res.set('Cache-Control', 'no-store');
      const out = await fn(ticket, req);
      if (Buffer.isBuffer(out)) return res.type('png').send(out);
      res.json({ ok: true, ...out });
    } catch (err) {
      const bad = err instanceof readyPost.HookError;
      if (!bad) log.warn({ err: err.message, path: req.path }, 'clean hook failed');
      res.status(bad ? 403 : 400).json({ ok: false, error: err.message });
    }
  };
  router.get('/hooks/clean/job', hook((ticket) => readyPost.cleanHookJob({ ticket })));
  router.get('/hooks/clean/token', hook((ticket) => readyPost.cleanHookToken({ ticket })));
  router.get('/hooks/clean/card.png', hook((ticket, req) => readyPost.cleanHookCard({ ticket, w: req.query.w, h: req.query.h })));
  router.post('/hooks/clean/progress', hook((ticket, req) => readyPost.cleanHookProgress({ ticket, ...(req.body || {}) })));
  router.post('/hooks/clean/done', hook((ticket, req) => readyPost.cleanHookDone({ ticket, fileId: (req.body || {}).fileId, durationSec: (req.body || {}).durationSec })));
  router.post('/hooks/clean/fail', hook((ticket, req) => readyPost.cleanHookFail({ ticket, error: (req.body || {}).error })));
}

export default { register };
