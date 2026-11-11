/**
 * Module: the client's connect link.
 *
 * Purpose:      A client opens the link its agency sent and connects its own
 *               channels, signing in on each platform itself: no password is
 *               shared and no app login is needed (docs/agency-build-plan.md,
 *               phase 4).
 * Responsibility: HTTP + HTML. The token's sha256 is looked up in tenant_config
 *               (connect_link = "<sha256>|<expires ISO>"); the account is
 *               connected with that workspace's own external_id.
 * Dependencies: tenantConfigRepository, tenantRepository, tenantSettings,
 *               planService, publishProvider, passwordSpec.
 *
 * Routes: GET  /api/v1/connect/:token          the page
 *         POST /api/v1/connect/:token/url      { platform } -> { url }
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { tenantInfo } from '../services/planService.js';
import { createPostForMeProvider } from '../providers/publishProvider.js';
import { hashToken } from '../utils/passwordSpec.js';
import { formatIst } from '../utils/time.js';

export const CONNECT_PLATFORMS = [
  ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['tiktok', 'TikTok'],
  ['tiktok_business', 'TikTok Business'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['threads', 'Threads'],
  ['pinterest', 'Pinterest'], ['bluesky', 'Bluesky'],
];

/** "<sha256>|<expires>" -> { hash, expires } or null when it has expired or is malformed (pure). */
export function parseLink(value, now = new Date()) {
  const [hash, iso] = String(value || '').split('|');
  const expires = new Date(iso || '');
  if (!hash || Number.isNaN(expires.getTime()) || expires <= now) return null;
  return { hash, expires };
}

/** The live workspace a token opens, or null. */
async function workspaceFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const hash = hashToken(token);
  const row = await tenantConfig.findConnectLink(hash);
  if (!row) return null;
  const link = parseLink(row.value);
  if (!link || link.hash !== hash) return null;
  const info = await tenantInfo(row.tenant_id).catch(() => ({ live: false }));
  if (!info.live) return null;
  const tenant = await tenantRepo.findById(row.tenant_id);
  return tenant ? { tenant, expires: link.expires } : null;
}

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/connect/:token', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const w = await workspaceFor(req.params.token);
      if (!w) return res.status(404).type('html').send(page('Link not valid', '<p>This link has expired or was replaced. Ask your agency for a new one.</p>'));
      res.type('html').send(page(`Connect ${w.tenant.name}`, connectBody(w)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/connect/:token/url', async (req, res) => {
    try {
      const w = await workspaceFor(req.params.token);
      if (!w) return res.status(404).json({ ok: false, error: 'This link has expired. Ask your agency for a new one.' });
      const platform = String(req.body?.platform || '').trim().toLowerCase();
      if (!CONNECT_PLATFORMS.some(([p]) => p === platform)) return res.json({ ok: false, error: 'Pick a platform' });
      const t = await tenantSettings.forTenant(String(w.tenant.id));
      if (!t.postformeKey) return res.json({ ok: false, error: 'Your agency has not set up posting yet. Ask them.' });
      const provider = createPostForMeProvider({ apiKey: t.postformeKey, scope: t.postformeScope }, log);
      const out = await provider.authUrl({ platform });
      log.info({ tenant: w.tenant.id, platform }, 'connect link used');
      return res.json({ ok: true, url: out.url });
    } catch (err) {
      return res.json({ ok: false, error: err.message });
    }
  });

  log.info('client connect link registered');
}

function connectBody(w) {
  const buttons = CONNECT_PLATFORMS
    .map(([p, label]) => `<button type="button" onclick="go('${p}', this)">${esc(label)}</button>`)
    .join('');
  return `<h1>Connect ${esc(w.tenant.name)}'s channels</h1>
  <p>Press a channel, sign in on that platform's own page and allow posting. Come back here for the next one. Nobody sees your passwords.</p>
  <div class="btns">${buttons}</div>
  <p id="st" class="hint"></p>
  <p class="hint">This link works until ${esc(formatIst(w.expires))}.</p>
  <script>
    async function go(platform, b) {
      const st = document.getElementById('st'); st.textContent = 'Opening ' + b.textContent + '…';
      try {
        const r = await fetch(location.pathname.replace(/\\/$/, '') + '/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform }) });
        const j = await r.json();
        if (!j.ok) { st.textContent = '🔴 ' + (j.error || 'failed'); return; }
        window.open(j.url, '_blank', 'noopener'); st.textContent = '🟢 ' + b.textContent + ' opened in a new tab. Finish there, then pick the next channel.';
      } catch (e) { st.textContent = '🔴 ' + e.message; }
    }
  </script>`;
}

function page(title, inner) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}, the content engine</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{font-family:system-ui;margin:0;background:#0b0b12;color:#e8e8ef}
 main{max-width:640px;margin:3rem auto;padding:0 1.2rem}
 h1{font-size:1.35rem}.hint{color:#8a8aa2;font-size:.85rem}
 .btns{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.6rem;margin:1.2rem 0}
 button{background:#2d6cdf;color:#fff;border:0;border-radius:10px;padding:.75rem 1rem;font-size:.95rem;cursor:pointer;font-family:inherit}
 footer{margin-top:3rem;color:#6f6f88;font-size:.78rem}
</style>
<main>${inner}<footer>The content engine</footer></main>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default { register, parseLink, CONNECT_PLATFORMS };
