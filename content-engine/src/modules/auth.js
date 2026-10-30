/**
 * Module: sign-in.
 *
 * Purpose:      Email + password sign-in for the admin pages and dashboard.
 * Responsibility: HTTP wiring only; the rules live in accessService, the
 *               markup in authPages.
 * Dependencies: accessService, authPages, passwordSpec.
 *
 * Routes:
 *   GET  /api/v1/admin/login      sign-in form (?next=/api/v1/...)
 *   POST /api/v1/admin/login      check email + password, start a session
 *   GET  /api/v1/admin/password   choose / change password (forced popup after a first sign-in)
 *   POST /api/v1/admin/password   save it
 *   GET  /api/v1/admin/reset      lockout reset with SUPER_ADMIN_RESET_CODE
 *   POST /api/v1/admin/reset
 *   POST /api/v1/admin/logout
 */
import * as access from '../services/accessService.js';
import { loginPage, passwordPage, resetPage } from '../utils/authPages.js';
import { safeNext } from '../utils/passwordSpec.js';

export function register(ctx) {
  const { router, log } = ctx;
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.get('/admin/login', async (req, res, next) => {
    try {
      noStore(res);
      const target = safeNext(req.query.next);
      const state = await access.gateState(req);
      if (state === 'ok') return res.redirect(target);
      if (state === 'change') return res.redirect(`/api/v1/admin/password?next=${encodeURIComponent(target)}`);
      res.type('html').send(loginPage({ next: target, notice: req.query.out ? 'Signed out.' : '' }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/login', async (req, res, next) => {
    try {
      noStore(res);
      const body = req.body || {};
      const target = safeNext(body.next);
      const email = String(body.email || '').trim().toLowerCase();
      const result = await access.signIn(res, email, String(body.password ?? ''));
      if (!result.ok) {
        log.warn({ email }, 'sign-in failed');
        return res.status(401).type('html').send(loginPage({ next: target, error: result.error, email }));
      }
      log.info({ email, first: !!result.mustChange }, 'signed in');
      if (result.mustChange) return res.redirect(`/api/v1/admin/password?next=${encodeURIComponent(target)}`);
      res.redirect(target);
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/password', async (req, res, next) => {
    try {
      noStore(res);
      const target = safeNext(req.query.next);
      const session = await access.currentSession(req);
      if (!session) return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(target)}`);
      res.type('html').send(passwordPage({ email: session.email, forced: session.mustChange, next: target }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/password', async (req, res, next) => {
    try {
      noStore(res);
      const body = req.body || {};
      const target = safeNext(body.next);
      const session = await access.currentSession(req);
      if (!session) return res.redirect(`/api/v1/admin/login?next=${encodeURIComponent(target)}`);
      const result = await access.changePassword(req, { current: body.current, password: body.password, confirm: body.confirm });
      if (!result.ok) {
        return res.status(400).type('html')
          .send(passwordPage({ email: session.email, forced: session.mustChange, next: target, error: result.error }));
      }
      log.info({ email: session.email }, 'password set');
      res.redirect(target);
    } catch (err) {
      next(err);
    }
  });

  router.get('/admin/reset', (req, res) => {
    noStore(res);
    res.type('html').send(resetPage({ enabled: access.resetEnabled() }));
  });

  router.post('/admin/reset', async (req, res, next) => {
    try {
      noStore(res);
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      const result = await access.resetWithCode(res, req.ip, {
        email, code: String(body.code ?? ''), password: body.password, confirm: body.confirm,
      });
      if (!result.ok) {
        log.warn({ email }, 'password reset failed');
        return res.status(401).type('html').send(resetPage({ enabled: access.resetEnabled(), error: result.error, email }));
      }
      log.warn({ email }, 'super-admin password reset with the reset code');
      res.redirect('/api/v1/admin/settings');
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/logout', async (req, res, next) => {
    try {
      await access.signOut(req, res);
      res.redirect('/api/v1/admin/login?out=1');
    } catch (err) {
      next(err);
    }
  });

  log.info('sign-in routes registered');
}

export default { register };
