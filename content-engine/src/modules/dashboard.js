/**
 * Module: unified operations dashboard.
 *
 * Purpose:      Serve the single-page dashboard covering all three services.
 * Responsibility: HTTP wiring + an optional access gate; rendering lives in
 *               dashboardService so it can be extracted into a standalone Admin
 *               UI later.
 * Dependencies: dashboardService, settings.
 *
 * Route: GET /api/v1/dashboard
 *
 * Access: guarded by an httpOnly access cookie (see accessService). Signing in
 * happens via /api/v1/admin/login; the key is never placed in a URL. An
 * existing `?key=` visit is migrated onto the cookie and stripped. Open when no
 * key is set.
 */
import * as dashboard from '../services/dashboardService.js';
import { keyOk, setAccessCookie } from '../services/accessService.js';

export function register(ctx) {
  const { router, log } = ctx;

  router.get('/dashboard', async (req, res, next) => {
    try {
      if (!(await keyOk(req))) return res.status(401).type('html').send(gatePage());
      if (req.query.key) {
        await setAccessCookie(res);
        return res.redirect('/api/v1/dashboard');
      }
      res.type('html').send(await dashboard.render(req.tenantId, {}));
    } catch (err) {
      next(err);
    }
  });

  log.info('unified dashboard route registered');
}

function gatePage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>automation — dashboard</title>
<style>body{font-family:system-ui;background:#0b0b12;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0}
form{background:#15151f;border:1px solid #24243a;padding:1.5rem;border-radius:12px;min-width:280px}
input{width:100%;padding:.6rem;margin:.6rem 0;border-radius:8px;border:1px solid #333;background:#0b0b12;color:#fff}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#2a2a44;color:#fff;cursor:pointer}
h1{font-size:1rem;margin:0 0 .3rem}</style>
<form method="post" action="/api/v1/admin/login">
  <h1>⚙️ automation dashboard</h1>
  <input type="hidden" name="next" value="dashboard">
  <input name="key" type="password" placeholder="Access key" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>`;
}

export default { register };
